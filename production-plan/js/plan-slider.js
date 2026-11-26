import { db, authReady, ref, set } from './firebase.js';
import { LINE_META, escapeHtml } from './utils.js';

const PUSH_WORKER_URL = 'https://plan-push-proxy.idc7260-fa1.workers.dev/';
const APP_TARGET_URL = 'https://idc7260.github.io/production-plan/';

// 작업 완료 관리자 푸시 알림
async function sendWorkCompletedPush({ lineLabel, dayLabel, itemName, itemQty, timeStr, url = APP_TARGET_URL }) {
  if (!PUSH_WORKER_URL) return;

  try {
    await fetch(PUSH_WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        lineLabel,
        dayLabel,
        itemName,
        itemQty,
        timeStr,
        url
      })
    });
  } catch (err) {
    console.warn('관리자 푸시 알림 발송 실패:', err);
  }
}

// 불량중단 관리자 푸시 알림 (사유 포함)
async function sendWorkPausedPush({ lineLabel, dayLabel, itemName, itemQty, timeStr, reason, url = APP_TARGET_URL }) {
  if (!PUSH_WORKER_URL) return;

  try {
    await fetch(PUSH_WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'pause',
        lineLabel,
        dayLabel,
        itemName,
        itemQty,
        timeStr,
        reason,
        url
      })
    });
  } catch (err) {
    console.warn('관리자 불량중단 푸시 알림 발송 실패:', err);
  }
}

export class InfinitePlanRenderer {
  constructor(viewportId, getState) {
    this.viewport = document.getElementById(viewportId);
    this.getState = getState; // () => ({ dbData, selectedWeekKey, isAuthorized, canEditPlan, currentEmpInfo })
    this.slider = null;
    this.days = [];
    this.currentLine = 'imprinting';
    this.currentDayIdx = 1;
    this.isAnimating = false;
    this.ANIM_TIME = 400;
    this.eventListeners = [];
  }

  // 현재 로그인한 계정이 '손님' 소속인지 판별
  isGuestUser() {
    const { canEditPlan, currentEmpInfo } = this.getState();
    if (canEditPlan) return false;
    const userDept = (currentEmpInfo?.dept || '').replace(/\s+/g, '').toLowerCase();
    return userDept === '손님' || userDept.includes('손님') || userDept === 'guest';
  }

  // 현재 로그인한 사원이 현재 보고 있는 공정(라인)의 작업 제어 권한이 있는지 판별
  canControlCurrentLine() {
    const { isAuthorized, canEditPlan, currentEmpInfo } = this.getState();
    if (!isAuthorized) return false;
    if (canEditPlan) return true;
    if (this.isGuestUser()) return false;

    const lineKey = String(this.currentLine);
    const lineLabel = LINE_META[lineKey]?.label || '';
    const userDept = (currentEmpInfo?.dept || '').replace(/\s+/g, '').toLowerCase();
    if (!userDept) return false;

    if (userDept.includes('관리') || userDept.includes('공통') || userDept === '전체' || userDept === 'admin') {
      return true;
    }

    const targetKey = lineKey.replace(/\s+/g, '').toLowerCase();
    const targetLabel = lineLabel.replace(/\s+/g, '').toLowerCase();

    return (
      userDept === targetKey ||
      userDept === targetLabel ||
      userDept.includes(targetLabel) ||
      (targetLabel && targetLabel.includes(userDept))
    );
  }

  getDaysFromDB(lineKey) {
    const { dbData, selectedWeekKey } = this.getState();
    const weekObj = dbData?.weeks?.[selectedWeekKey];
    if (!weekObj) return [];

    const lineDays = weekObj.lines?.[String(lineKey)];
    if (!lineDays || lineDays.length === 0) {
      const refDays = weekObj.lines?.['1'] || weekObj.lines?.['2'] || weekObj.lines?.['imprinting'] || [];
      return refDays.map(d => ({
        date: d.date,
        dayLabel: d.dayLabel,
        items: []
      }));
    }
    return lineDays;
  }

  formatNowHHMM() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  async handleWorkAction(dayIdx, itemIdx, action) {
    const { dbData, selectedWeekKey, currentEmpInfo } = this.getState();
    if (!selectedWeekKey || !this.canControlCurrentLine()) return;

    const lineKey = String(this.currentLine);
    const weekObj = dbData?.weeks?.[selectedWeekKey];
    const lineDays = weekObj?.lines?.[lineKey];
    const targetDay = lineDays?.[dayIdx];
    const targetItem = targetDay?.items?.[itemIdx];
    if (!targetItem) return;

    const prevLogs = Array.isArray(targetItem.timeLogs) ? targetItem.timeLogs : [];

    // [완료취소] 처리
    if (action === 'uncomplete') {
      if (!confirm(`[${targetItem.name}] 완료 처리를 취소하고 이전 상태로 되돌리시겠습니까?`)) {
        return;
      }

      const nextLogs = [...prevLogs];
      if (nextLogs.length > 0 && nextLogs[nextLogs.length - 1].type === 'complete') {
        nextLogs.pop();
      }

      const lastLog = nextLogs[nextLogs.length - 1];
      const restoredStatus = !lastLog
        ? 'idle'
        : lastLog.type === 'pause'
        ? 'paused'
        : 'running';

      try {
        await authReady;
        const itemRef = ref(
          db,
          `/production-plan/weeks/${selectedWeekKey}/lines/${lineKey}/${dayIdx}/items/${itemIdx}`
        );
        await set(itemRef, {
          ...targetItem,
          workStatus: restoredStatus,
          timeLogs: nextLogs
        });
      } catch (err) {
        console.error('완료 취소 실패:', err);
        alert('완료 취소 처리 중 오류가 발생했습니다.');
      }
      return;
    }

    const actionLabels = {
      start: '시작',
      pause: '불량중단',
      resume: '재시작',
      complete: '완료'
    };

    if (action === 'complete' && !confirm(`[${targetItem.name}] 작업을 완료 처리하시겠습니까?`)) {
      return;
    }

    // 불량중단 시 사유 입력 받기
    let reason = '';
    if (action === 'pause') {
      const inputReason = prompt('불량(중단) 사유를 입력해 주세요:');
      if (inputReason === null) return; // 취소 버튼 누른 경우
      reason = inputReason.trim();
      if (!reason) {
        alert('불량 사유를 입력해야 중단 처리할 수 있습니다.');
        return;
      }
    }

    const timeStr = this.formatNowHHMM();
    const empName = (currentEmpInfo?.name || '').trim();
    const nextStatus =
      action === 'start' || action === 'resume' ? 'running'
      : action === 'pause' ? 'paused'
      : 'completed';

    const nextLogs = [
      ...prevLogs,
      {
        type: action,
        label: actionLabels[action],
        time: timeStr,
        ...(reason ? { reason } : {}),
        ...(empName ? { empName } : {})
      }
    ];

    try {
      await authReady;
      const itemRef = ref(
        db,
        `/production-plan/weeks/${selectedWeekKey}/lines/${lineKey}/${dayIdx}/items/${itemIdx}`
      );
      await set(itemRef, {
        ...targetItem,
        workStatus: nextStatus,
        timeLogs: nextLogs
      });

      const lineLabel = LINE_META[lineKey]?.label || lineKey;

      if (action === 'complete') {
        sendWorkCompletedPush({
          lineLabel,
          dayLabel: targetDay.dayLabel || '',
          itemName: targetItem.name || '',
          itemQty: targetItem.qty || '',
          timeStr,
          url: APP_TARGET_URL
        });
      } else if (action === 'pause') {
        sendWorkPausedPush({
          lineLabel,
          dayLabel: targetDay.dayLabel || '',
          itemName: targetItem.name || '',
          itemQty: targetItem.qty || '',
          timeStr,
          reason,
          url: APP_TARGET_URL
        });
      }
    } catch (err) {
      console.error('작업 상태 업데이트 실패:', err);
      alert('작업 상태를 저장하는 중 오류가 발생했습니다.');
    }
  }

  loadLine(lineKey, keepDayIdx = null) {
    this.destroy();
    this.currentLine = lineKey;

    const { dbData, selectedWeekKey } = this.getState();
    const meta = LINE_META[lineKey];
    const weekObj = dbData?.weeks?.[selectedWeekKey];

    document.getElementById('current-header-title').textContent = weekObj ? (weekObj.period || meta.label) : '일정 없음';
    const lineSelectEl = document.getElementById('line-select');
    if (lineSelectEl) {
      lineSelectEl.value = String(lineKey);
    }

    if (!dbData) {
      this.viewport.innerHTML = `<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#475569;font-weight:700;">데이터를 불러오는 중입니다...</div>`;
      return;
    }

    if (!weekObj) {
      this.viewport.innerHTML = `<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#475569;font-weight:700;">생성된 주차가 없습니다. 상단 [➕ 다음 주간 생성]을 눌러 시작하세요.</div>`;
      return;
    }

    this.days = this.getDaysFromDB(lineKey);
    this.renderSlides();

    if (keepDayIdx !== null && keepDayIdx >= 1 && keepDayIdx <= this.days.length) {
      this.currentDayIdx = keepDayIdx;
    } else {
      const dayNum = new Date().getDay();
      this.currentDayIdx = dayNum === 0 ? 7 : dayNum;
    }

    this.moveTo(this.currentDayIdx, false);
    this.updateHeaderTitle();
    this.initEvents();
  }

  updateHeaderTitle() {
    if (!this.days.length) return;
    const dayObj = this.days[this.currentDayIdx - 1];
    if (!dayObj) return;

    const headerTitleEl = document.getElementById('current-header-title');
    if (headerTitleEl) {
      headerTitleEl.textContent = dayObj.dayLabel;
    }
  }

  createSlideElement(dayData, dayIdx) {
    const slide = document.createElement('section');
    slide.className = 'day-slide';

    let contentHtml = '';
    if (dayData.imageUrl) {
      contentHtml = `
        <div class="sheet-image-wrap">
          <img src="${dayData.imageUrl}" alt="${dayData.dayLabel} 생산계획서" />
        </div>
      `;
    } else {
      const items = dayData.items || [];
      const hasItems = items.length > 0;
      const isGuest = this.isGuestUser();
      const canControl = !isGuest && this.canControlCurrentLine();
      const rows = hasItems
        ? items
        : [{ seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-', note: '' }];

      const rowsHtml = rows.map((r, itemIdx) => {
        const status = r.workStatus || 'idle';
        const logs = Array.isArray(r.timeLogs) ? r.timeLogs : [];

        const isStartDisabled = status !== 'idle';
        const isPauseOrResumeDisabled = status === 'idle' || status === 'completed';

        const midAction = status === 'paused' ? 'resume' : 'pause';
        const midLabel = status === 'paused' ? '재시작' : '불량중단';

        const isCompleted = status === 'completed';
        const endAction = isCompleted ? 'uncomplete' : 'complete';
        const endLabel = isCompleted ? '완료취소' : '완료';
        const isEndDisabled = status === 'idle';

        // 손님 계정은 진행 상태 배지, 작업 버튼, 시간 로그 전부 비노출
        const statusBadgeHtml = isGuest
          ? ''
          : status === 'running'
          ? `<span class="status-badge-inline running"><span class="gear-icon">⚙️</span>진행중</span>`
          : status === 'paused'
          ? `<span class="status-badge-inline paused">⏸ 불량중단</span>`
          : status === 'completed'
          ? `<span class="status-badge-inline completed">✔ 완료</span>`
          : '';

        const logsHtml = isGuest
          ? ''
          : logs.map(log => `
              <span class="time-tag ${escapeHtml(log.type)}" ${log.reason ? `title="중단 사유: ${escapeHtml(log.reason)}"` : ''}>
                [${escapeHtml(log.label)}] ${escapeHtml(log.time)}${log.reason ? ` <span style="font-weight:400; opacity:0.9;">(${escapeHtml(log.reason)})</span>` : ''}
              </span>
            `).join('');

        const workBtnsHtml = canControl ? `
          <div class="item-work-btns">
            <button type="button"
              class="work-btn start"
              data-day-idx="${dayIdx}"
              data-item-idx="${itemIdx}"
              data-action="start"
              ${isStartDisabled ? 'disabled' : ''}>시작</button>
            <button type="button"
              class="work-btn ${midAction}"
              data-day-idx="${dayIdx}"
              data-item-idx="${itemIdx}"
              data-action="${midAction}"
              ${isPauseOrResumeDisabled ? 'disabled' : ''}>${midLabel}</button>
            <button type="button"
              class="work-btn ${endAction}"
              data-day-idx="${dayIdx}"
              data-item-idx="${itemIdx}"
              data-action="${endAction}"
              ${isEndDisabled ? 'disabled' : ''}>${endLabel}</button>
          </div>
        ` : '';

        const workBarHtml = (!isGuest && hasItems && (canControl || logsHtml)) ? `
          <div class="item-work-bar">
            ${workBtnsHtml}
            ${logsHtml ? `<div class="item-work-logs">${logsHtml}</div>` : ''}
          </div>
        ` : '';

        return `
          <tr>
            <td><strong>${escapeHtml(r.seq ?? '-')}</strong></td>
            <td style="text-align:left; padding-left:16px;">
              <div>
                <strong style="white-space: pre-line;">${escapeHtml(r.name || '-')}</strong>
                ${statusBadgeHtml}
              </div>
              ${r.note ? `<div style="font-size:0.8em; color:#64748b; margin-top:4px; font-weight:500; white-space: pre-line;">※ ${escapeHtml(r.note)}</div>` : ''}
              ${workBarHtml}
            </td>
            <td><strong>${escapeHtml(r.qty || '-')}</strong></td>
            <td>
              <span class="process-badge ${!r.process || r.process === '-' ? 'process-empty' : ''}">
                ${escapeHtml(r.process || '-')}
              </span>
            </td>
          </tr>
        `;
      }).join('');

      contentHtml = `
        <table class="plan-table">
          <thead>
            <tr>
              <th style="width:10%;">순번</th>
              <th style="width:56%;">품명 및 사양</th>
              <th style="width:18%;">수량</th>
              <th style="width:16%;">공정</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
    }

    slide.innerHTML = `
      <div class="sheet-card">
        ${contentHtml}
      </div>
    `;
    return slide;
  }

  renderSlides() {
    this.viewport.innerHTML = '';
    const slider = document.createElement('div');
    slider.className = 'plan-slider';
    this.slider = slider;

    if (this.days.length === 0) return;

    const firstClone = this.createSlideElement(this.days[0], 0);
    const lastClone = this.createSlideElement(this.days[this.days.length - 1], this.days.length - 1);

    slider.append(lastClone);
    this.days.forEach((day, idx) => slider.append(this.createSlideElement(day, idx)));
    slider.append(firstClone);

    this.viewport.append(slider);
  }

  moveTo(idx, animate = true) {
    if (!this.slider) return;
    this.slider.style.transition = animate
      ? `transform ${this.ANIM_TIME}ms cubic-bezier(0.2, 0.8, 0.2, 1)`
      : 'none';
    this.slider.style.transform = `translateX(-${idx * 100}vw)`;
  }

  step(dir) {
    if (this.isAnimating || this.days.length === 0) return;
    this.isAnimating = true;

    const total = this.days.length;
    this.currentDayIdx += dir;
    this.moveTo(this.currentDayIdx, true);

    if (this.currentDayIdx <= 0 || this.currentDayIdx >= total + 1) {
      setTimeout(() => {
        this.currentDayIdx = this.currentDayIdx <= 0 ? total : 1;
        this.moveTo(this.currentDayIdx, false);
        this.updateHeaderTitle();
        this.isAnimating = false;
      }, this.ANIM_TIME);
      return;
    }

    this.updateHeaderTitle();
    setTimeout(() => {
      this.isAnimating = false;
    }, this.ANIM_TIME);
  }

  addListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.eventListeners.push({ target, type, listener, options });
  }

  destroy() {
    this.eventListeners.forEach(({ target, type, listener, options }) => {
      target.removeEventListener(type, listener, options);
    });
    this.eventListeners = [];
  }

  initEvents() {
    this.addListener(this.viewport, 'click', (e) => {
      const btn = e.target.closest('.work-btn');
      if (!btn || btn.disabled) return;
      const dayIdx = Number(btn.dataset.dayIdx);
      const itemIdx = Number(btn.dataset.itemIdx);
      const action = btn.dataset.action;
      this.handleWorkAction(dayIdx, itemIdx, action);
    });

    this.addListener(this.viewport, 'wheel', (e) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) > 20) {
        this.step(delta > 0 ? 1 : -1);
      }
    }, { passive: true });

    let isMouseDown = false;
    let startX = 0;

    this.addListener(this.viewport, 'mousedown', (e) => {
      if (e.target.closest('.work-btn')) return;
      isMouseDown = true;
      startX = e.clientX;
    }, { passive: true });

    this.addListener(window, 'mouseup', (e) => {
      if (!isMouseDown) return;
      isMouseDown = false;
      const dx = startX - e.clientX;
      if (Math.abs(dx) > 50) {
        this.step(dx > 0 ? 1 : -1);
      }
    }, { passive: true });

    let touchStartX = 0;
    this.addListener(this.viewport, 'touchstart', (e) => {
      if (e.touches.length > 1 || e.target.closest('.work-btn')) return;
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    this.addListener(this.viewport, 'touchend', (e) => {
      if (e.touches.length > 0 || !touchStartX) return;
      const dx = touchStartX - e.changedTouches[0].clientX;
      touchStartX = 0;
      if (Math.abs(dx) > 40) {
        this.step(dx > 0 ? 1 : -1);
      }
    }, { passive: true });

    this.addListener(window, 'keydown', (e) => {
      if (document.getElementById('plan-edit-modal').style.display === 'flex') return;
      if (e.key === 'ArrowRight') this.step(1);
      if (e.key === 'ArrowLeft') this.step(-1);
    });

    this.addListener(window, 'resize', () => {
      this.moveTo(this.currentDayIdx, false);
    });
  }
}