import { db, authReady, ref, get, set } from './firebase.js';
import {
  DAY_NAMES_KO,
  getWeekTemplateKey,
  arrayBufferToBase64,
  base64ToUint8Array
} from './utils.js';

export function parseExcelPlanCell(rawText, processText, fallbackSeq) {
  const text = String(rawText ?? '').trim();
  const proc = String(processText ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let firstLine = lines[0] || '';
  const noteLines = lines.slice(1);

  let seq = String(fallbackSeq);
  const seqMatch = firstLine.match(/^(\d+)\.\s*(.+)$/);
  if (seqMatch) {
    seq = seqMatch[1];
    firstLine = seqMatch[2].trim();
  }

  let qty = '-';
  let name = firstLine;
  const qtyMatch = firstLine.match(/^(.*?)\s+([\d,]+\s*[mM])\s*$/);
  if (qtyMatch && qtyMatch[1].trim()) {
    name = qtyMatch[1].trim();
    qty = qtyMatch[2].replace(/\s+/g, '');
  }

  return {
    seq,
    name,
    qty,
    process: proc || '-',
    note: noteLines.join('\n')
  };
}

export function detectLineKeyFromCell(cellVal) {
  const norm = String(cellVal ?? '').replace(/\s+/g, '').toUpperCase();
  if (!norm) return null;
  if (norm.includes('1호기')) return '1';
  if (norm.includes('2호기')) return '2';
  if (norm.includes('IMPRINTING') || norm.includes('임프린팅')) return 'imprinting';
  return null;
}

function extractCellPlainText(cellValue) {
  if (cellValue === null || cellValue === undefined) return '';
  if (typeof cellValue === 'object') {
    if (Array.isArray(cellValue.richText)) {
      return cellValue.richText.map(t => t.text || '').join('');
    }
    if (cellValue.result !== undefined) return String(cellValue.result);
    if (cellValue.text !== undefined) return String(cellValue.text);
  }
  return String(cellValue);
}

export async function syncLatestTemplateFile(dbData, weekKey, overrideLineKey = null, overrideDays = null) {
  const weekObj = dbData?.weeks?.[weekKey];
  if (!weekObj) return null;
  if (typeof ExcelJS === 'undefined') {
    alert('ExcelJS 라이브러리가 로드되지 않았습니다. index.html의 script 태그를 확인해 주세요.');
    return null;
  }

  const tplKey = getWeekTemplateKey(weekKey);
  const tplRef = ref(db, `/production-plan-templates/${tplKey}`);
  const tplSnap = await get(tplRef);
  const tplData = tplSnap.val();

  const sourceBase64 = tplData?.originalBase64 || tplData?.base64;
  if (!sourceBase64) return null;

  const mergedLines = { ...(weekObj.lines || {}) };
  if (overrideLineKey !== null && overrideDays) {
    mergedLines[String(overrideLineKey)] = overrideDays;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(base64ToUint8Array(sourceBase64));

  let sheet = null;
  let headerRowNum = 5;
  let lineColNum = 2;

  for (const ws of workbook.worksheets) {
    for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= Math.min(ws.columnCount, 10); c++) {
        if (extractCellPlainText(row.getCell(c).value).replace(/\s+/g, '') === '라인') {
          sheet = ws;
          headerRowNum = r;
          lineColNum = c;
          break;
        }
      }
      if (sheet) break;
    }
    if (sheet) break;
  }

  if (!sheet) {
    console.warn('템플릿 엑셀에서 "라인" 헤더 시트를 찾지 못했습니다.');
    return null;
  }

  const lineBlocks = [];
  let currentBlock = null;
  for (let r = headerRowNum + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cellA = row.getCell(1);
    const cellB = row.getCell(lineColNum);

    if (cellA.isMerged && cellB.isMerged && cellA.master && cellB.master && cellA.master.address === cellB.master.address) {
      break;
    }

    const isLineStartCell = !cellB.isMerged || (cellB.master && cellB.master.address === cellB.address);
    const detected = isLineStartCell ? detectLineKeyFromCell(extractCellPlainText(cellB.value)) : null;

    if (detected) {
      if (currentBlock) {
        currentBlock.endRow = r - 1;
        lineBlocks.push(currentBlock);
      }
      currentBlock = { key: detected, startRow: r, endRow: r };
    } else if (currentBlock) {
      currentBlock.endRow = r;
    }
  }
  if (currentBlock) lineBlocks.push(currentBlock);

  let rowShift = 0;
  for (const block of lineBlocks) {
    const actualStart = block.startRow + rowShift;
    const baseCount = block.endRow - block.startRow + 1;
    const lineDays = mergedLines[String(block.key)] || [];

    const neededRows = Math.max(
      baseCount,
      ...Array.from({ length: 7 }, (_, d) => (lineDays[d]?.items || []).length)
    );

    if (neededRows > baseCount) {
      const extra = neededRows - baseCount;
      const sampleRow = sheet.getRow(actualStart + Math.max(0, baseCount - 2));
      const maxCols = Math.max(sheet.columnCount, lineColNum + 14);

      try {
        sheet.unMergeCells(actualStart, lineColNum, actualStart + baseCount - 1, lineColNum);
      } catch (_) {}

      for (let e = 0; e < extra; e++) {
        const inserted = sheet.insertRow(actualStart + baseCount, []);
        inserted.height = sampleRow.height;
        for (let c = 1; c <= maxCols; c++) {
          const srcStyle = sampleRow.getCell(c).style;
          if (srcStyle) inserted.getCell(c).style = JSON.parse(JSON.stringify(srcStyle));
        }
      }

      try {
        sheet.mergeCells(actualStart, lineColNum, actualStart + neededRows - 1, lineColNum);
      } catch (_) {}
      rowShift += extra;
    }

    for (let r = 0; r < neededRows; r++) {
      const targetRow = sheet.getRow(actualStart + r);
      for (let d = 0; d < 7; d++) {
        const planCell = targetRow.getCell(lineColNum + 1 + d * 2);
        const procCell = targetRow.getCell(lineColNum + 2 + d * 2);
        const item = lineDays[d]?.items?.[r];

        const targetPlanCell = (planCell.isMerged && planCell.master) ? planCell.master : planCell;
        const targetProcCell = (procCell.isMerged && procCell.master) ? procCell.master : procCell;

        if (item && (item.name || item.qty || item.note)) {
          const seqPrefix = item.seq && item.seq !== '-' ? `${item.seq}. ` : `${r + 1}. `;
          const qtySuffix = item.qty && item.qty !== '-' ? ` ${item.qty}` : '';
          const noteSuffix = item.note ? `\n${item.note}` : '';
          targetPlanCell.value = `${seqPrefix}${item.name || ''}${qtySuffix}${noteSuffix}`.trim();
          targetProcCell.value = item.process && item.process !== '-' ? item.process : null;
        } else {
          targetPlanCell.value = null;
          targetProcCell.value = null;
        }
      }
    }
  }

  const outBuffer = await workbook.xlsx.writeBuffer();
  const latestBase64 = arrayBufferToBase64(outBuffer);

  await set(tplRef, {
    ...tplData,
    originalBase64: sourceBase64,
    latestBase64,
    updatedAt: new Date().toISOString()
  });

  return { latestBase64, fileName: tplData.fileName };
}

function downloadFallbackPlainExcel(planRenderer, weekObj, yearStr, monthNum) {
  const days1 = planRenderer.getDaysFromDB('1');
  const days2 = planRenderer.getDaysFromDB('2');
  const daysImp = planRenderer.getDaysFromDB('imprinting');
  const baseDays = days1.length ? days1 : (days2.length ? days2 : daysImp);

  const periodLabel = weekObj.period || `${yearStr}년 ${monthNum}월`;
  const titleText = `${periodLabel} 주간 통합생산계획서`;
  const aoa = [
    [titleText, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    new Array(16).fill(null),
    [null, null, null, null, null, null, null, null, `   ${periodLabel}`, null, null, null, null, null, null, null],
    new Array(16).fill(null)
  ];

  const headerRow = [' ', '라인'];
  for (let d = 0; d < 7; d++) {
    const dayInfo = baseDays[d];
    let colLabel = dayInfo?.dayLabel || '';
    if (dayInfo?.date && /^\d{4}-\d{2}-\d{2}$/.test(dayInfo.date)) {
      const mm = Number(dayInfo.date.slice(5, 7));
      const dd = Number(dayInfo.date.slice(8, 10));
      const shortDay = (dayInfo.dayLabel || '').replace(/요일/, '').slice(-2).replace(/[()]/g, '').trim();
      colLabel = `${mm}/${dd}일${shortDay ? ` (${shortDay})` : ''}`;
    }
    headerRow.push(colLabel, '공정');
  }
  aoa.push(headerRow);

  const lineConfigs = [
    { key: '1', label: '1\n호\n기' },
    { key: '2', label: '2\n호\n기' },
    { key: 'imprinting', label: 'IMPRINTING' }
  ];

  lineConfigs.forEach((cfg) => {
    const lineDays = planRenderer.getDaysFromDB(cfg.key);
    const maxItems = Math.max(1, ...Array.from({ length: 7 }, (_, d) => (lineDays[d]?.items || []).length));
    for (let r = 0; r < maxItems; r++) {
      const rowArr = new Array(16).fill(null);
      if (r === 0) rowArr[1] = cfg.label;
      for (let d = 0; d < 7; d++) {
        const item = lineDays[d]?.items?.[r];
        if (item && (item.name || item.qty || item.note)) {
          const seqPrefix = item.seq && item.seq !== '-' ? `${item.seq}. ` : `${r + 1}. `;
          const qtySuffix = item.qty && item.qty !== '-' ? ` ${item.qty}` : '';
          const noteSuffix = item.note ? `\n${item.note}` : '';
          rowArr[2 + d * 2] = `${seqPrefix}${item.name || ''}${qtySuffix}${noteSuffix}`.trim();
          rowArr[3 + d * 2] = item.process && item.process !== '-' ? item.process : '';
        }
      }
      aoa.push(rowArr);
    }
  });

  const safePeriod = periodLabel.replace(/\s+/g, '_');
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `${monthNum}월 생산계획`);
  XLSX.writeFile(wb, `IDC_주간통합생산계획서_${safePeriod}.xlsx`);
}

export function initExcelSyncHandlers({ getState, setSelectedWeekKey, planRenderer, weekSelectEl }) {
  const fileInputEl = document.getElementById('excel-file-input');

  // 1) [주간 엑셀 받기] (index.html: #btn-export-excel)
  document.getElementById('btn-export-excel')?.addEventListener('click', async () => {
    const { dbData, selectedWeekKey } = getState();
    const weekObj = dbData?.weeks?.[selectedWeekKey];
    if (!weekObj) return;

    const days1 = planRenderer.getDaysFromDB('1');
    const days2 = planRenderer.getDaysFromDB('2');
    const daysImp = planRenderer.getDaysFromDB('imprinting');
    const baseDays = days1.length ? days1 : (days2.length ? days2 : daysImp);

    const yearStr = (baseDays[0]?.date || String(new Date().getFullYear())).slice(0, 4);
    const monthNum = baseDays[0]?.date ? Number(baseDays[0].date.slice(5, 7)) : (new Date().getMonth() + 1);
    const tplKey = getWeekTemplateKey(selectedWeekKey);

    try {
      await authReady;
      const tplSnap = await get(ref(db, `/production-plan-templates/${tplKey}`));
      const tplData = tplSnap.val();

      if (!tplData) {
        downloadFallbackPlainExcel(planRenderer, weekObj, yearStr, monthNum);
        return;
      }

      let downloadBase64 = tplData.latestBase64;
      if (!downloadBase64) {
        const synced = await syncLatestTemplateFile(dbData, selectedWeekKey);
        downloadBase64 = synced?.latestBase64;
      }

      if (!downloadBase64) {
        downloadFallbackPlainExcel(planRenderer, weekObj, yearStr, monthNum);
        return;
      }

      const safePeriod = (weekObj.period || `${yearStr}년_${monthNum}월`).replace(/\s+/g, '_');
      const blob = new Blob([base64ToUint8Array(downloadBase64)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = tplData.fileName || `IDC_주간통합생산계획서_${safePeriod}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('엑셀 다운로드 실패:', err);
      alert('엑셀 파일을 내려받는 중 오류가 발생했습니다.');
    }
  });

  // 2) [주간 엑셀 업로드] 버튼 클릭 시 숨겨진 파일 선택창 열기 (index.html: #btn-import-excel)
  document.getElementById('btn-import-excel')?.addEventListener('click', () => {
    const { canEditPlan } = getState();
    if (!canEditPlan) return;
    if (fileInputEl) {
      fileInputEl.value = '';
      fileInputEl.click();
    }
  });

  // 3) 엑셀 파일 선택 후 파싱 및 DB 반영 (index.html: #excel-file-input)
  fileInputEl?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const { dbData, canEditPlan } = getState();
    let { selectedWeekKey } = getState();
    if (!file || !canEditPlan) return;

    if (weekSelectEl && weekSelectEl.value) {
      selectedWeekKey = weekSelectEl.value;
      setSelectedWeekKey(selectedWeekKey);
    }

    const weekObj = dbData?.weeks?.[selectedWeekKey];
    if (!weekObj) {
      alert('선택된 일정 정보를 찾을 수 없습니다. 먼저 주간 일정을 생성해 주세요.');
      e.target.value = '';
      return;
    }

    const periodLabel = weekObj.period || selectedWeekKey;
    if (!confirm(`[${periodLabel}] 전체 라인(1호기 · 2호기 · 임프린팅) 생산계획을 선택한 통합 엑셀 파일로 일괄 업데이트하시겠습니까?\n(업로드한 양식 서식도 함께 보관됩니다)`)) {
      e.target.value = '';
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

      let headerRowIdx = -1;
      let lineColIdx = 1;
      const dayColPairs = [];

      for (let r = 0; r < Math.min(grid.length, 15); r++) {
        const row = grid[r] || [];
        const foundLineCol = row.findIndex(cell => String(cell ?? '').replace(/\s+/g, '') === '라인');
        if (foundLineCol !== -1) {
          headerRowIdx = r;
          lineColIdx = foundLineCol;
          for (let d = 0; d < 7; d++) {
            const planCol = lineColIdx + 1 + d * 2;
            const procCol = planCol + 1;
            if (planCol < row.length) {
              dayColPairs.push({ dayIdx: d, planCol, procCol });
            }
          }
          break;
        }
      }

      if (headerRowIdx === -1 || dayColPairs.length === 0) {
        alert('엑셀에서 "라인" 헤더 행을 찾을 수 없습니다. 주간 통합생산계획서 양식인지 확인해 주세요.');
        return;
      }

      const horizontalMergedRows = new Set();
      (sheet['!merges'] || []).forEach((m) => {
        if (m.s.c === 0 && m.e.c >= 1) {
          for (let mr = m.s.r; mr <= m.e.r; mr++) {
            horizontalMergedRows.add(mr);
          }
        }
      });

      const baseTemplateDays =
        weekObj.lines?.['1'] ||
        weekObj.lines?.['2'] ||
        weekObj.lines?.['imprinting'] ||
        Array.from({ length: 7 }, (_, i) => ({
          date: '',
          dayLabel: `${DAY_NAMES_KO[(i + 1) % 7]}`,
          items: []
        }));

      const cloneWeekDays = (rawDays) => {
        const src = Array.isArray(rawDays) && rawDays.length >= 7 ? rawDays : baseTemplateDays;
        return JSON.parse(JSON.stringify(src)).map(d => ({
          ...d,
          items: []
        }));
      };

      const updatedLines = {
        '1': cloneWeekDays(weekObj.lines?.['1']),
        '2': cloneWeekDays(weekObj.lines?.['2']),
        'imprinting': cloneWeekDays(weekObj.lines?.['imprinting'])
      };

      let activeLineKey = null;
      let totalImported = 0;

      for (let r = headerRowIdx + 1; r < grid.length; r++) {
        if (horizontalMergedRows.has(r)) break;

        const row = grid[r] || [];
        const detectedLine = detectLineKeyFromCell(row[lineColIdx]);
        if (detectedLine) {
          activeLineKey = detectedLine;
        }

        if (!activeLineKey || !updatedLines[activeLineKey]) continue;

        dayColPairs.forEach(({ dayIdx, planCol, procCol }) => {
          const targetDay = updatedLines[activeLineKey][dayIdx];
          if (!targetDay) return;

          const parsed = parseExcelPlanCell(
            row[planCol],
            row[procCol],
            targetDay.items.length + 1
          );

          if (parsed) {
            targetDay.items.push(parsed);
            totalImported++;
          }
        });
      }

      if (totalImported === 0) {
        alert('엑셀에서 읽어올 생산계획 항목을 찾지 못했습니다.');
        return;
      }

      await authReady;
      await set(ref(db, `/production-plan/weeks/${selectedWeekKey}/lines`), updatedLines);

      dbData.weeks[selectedWeekKey].lines = updatedLines;
      planRenderer.loadLine(planRenderer.currentLine, planRenderer.currentDayIdx);

      if (file.name.toLowerCase().endsWith('.xlsx')) {
        const tplKey = getWeekTemplateKey(selectedWeekKey);
        const uploadedBase64 = arrayBufferToBase64(buffer);
        await set(ref(db, `/production-plan-templates/${tplKey}`), {
          originalBase64: uploadedBase64,
          latestBase64: uploadedBase64,
          fileName: file.name,
          uploadedAt: new Date().toISOString()
        });
      }

      alert(`총 ${totalImported}건의 생산계획과 원본 양식 서식이 [${periodLabel}]에 반영되었습니다.`);
    } catch (err) {
      console.error('통합 엑셀 업로드 실패:', err);
      alert('엑셀 파일을 처리하는 중 오류가 발생했습니다.');
    } finally {
      e.target.value = '';
    }
  });
}