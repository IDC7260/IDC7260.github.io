import { db, authReady, ref, get, set, onValue } from './firebase.js';
import {
  LINE_META,
  DAY_NAMES_KO,
  STORAGE_EMP_KEY,
  sanitizeId,
  escapeHtml,
  parseLocalDateStr,
  formatDateYMD,
  getMondayOfDate,
  getSortedWeekKeys,
  findCurrentWeekKey
} from './utils.js';
import { InfinitePlanRenderer } from './plan-slider.js';
import { syncLatestTemplateFile, initExcelSyncHandlers } from './excel-sync.js';

/* =========================================
1. 서비스 워커 등록 및 자동 새로고침
   ========================================= */
if ('serviceWorker' in navigator) {
  let swRegistration;

  navigator.serviceWorker.register('./sw.js').then(reg => {
    swRegistration = reg;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && swRegistration) {
      swRegistration.update();
    }
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

/* =========================================
2. 전역 상태 및 DOM 참조
   ========================================= */
let dbData = null;
let selectedWeekKey = '';
let unsubscribePlanDB = null;
let unsubscribeEmpWatch = null;

let isAuthorized = false;
let canEditPlan = false;
let currentEmpInfo = null;
let isPendingApproval = false;
let pendingUserDisplay = '';
let pendingLine = null;

const loginScreen = document.getElementById('login-screen');
const selectScreen = document.getElementById('select-screen');
const planScreen = document.getElementById('plan-screen');
const lineSelectEl = document.getElementById('line-select');
const weekSelectEl = document.getElementById('week-select');
const plannerToolbar = document.getElementById('planner-toolbar');

const getAppState = () => ({ dbData, selectedWeekKey, isAuthorized, canEditPlan });
const planRenderer = new InfinitePlanRenderer('plan-viewport', getAppState);

function renderWeekOptions(weeksObj) {
  const allKeys = getSortedWeekKeys(weeksObj);
  if (allKeys.length === 0) {
    weekSelectEl.innerHTML = '';
    return;
  }

  const cutoffDate = getMondayOfDate(new Date());
  cutoffDate.setDate(cutoffDate.getDate() - 56);
  const cutoffKey = formatDateYMD(cutoffDate);

  let visibleKeys = allKeys.filter(k => k >= cutoffKey);
  if (visibleKeys.length === 0) {
    visibleKeys = allKeys.slice(-8);
  }

  if (!selectedWeekKey || !visibleKeys.includes(selectedWeekKey)) {
    selectedWeekKey = findCurrentWeekKey(weeksObj);
    if (!visibleKeys.includes(selectedWeekKey)) {
      selectedWeekKey = visibleKeys[visibleKeys.length - 1];
    }
  }

  weekSelectEl.innerHTML = visibleKeys.map((key) => {
    const w = weeksObj[key];
    const shortPeriod = w.period ? w.period.split(' ').slice(1).join(' ') : key;
    return `<option value="${key}">${shortPeriod}</option>`;
  }).join('');

  weekSelectEl.value = selectedWeekKey;
}

async function startPlanDatabaseListener() {
  if (unsubscribePlanDB) return;
  await authReady;

  const planRef = ref(db, '/production-plan');
  unsubscribePlanDB = onValue(planRef, (snapshot) => {
    const val = snapshot.val() || {};
    const isFirstLoad = dbData === null;
    dbData = {
      ...val,
      weeks: (val.weeks && typeof val.weeks === 'object') ? val.weeks : {}
    };

    if (isFirstLoad || !selectedWeekKey || !dbData.weeks[selectedWeekKey]) {
      selectedWeekKey = findCurrentWeekKey(dbData.weeks);
    }
    renderWeekOptions(dbData.weeks);

    if (planScreen.style.display === 'flex') {
      planRenderer.loadLine(planRenderer.currentLine, planRenderer.currentDayIdx);
    }
  }, (error) => {
    console.error("Firebase DB 로드 실패:", error);
  });
}

function stopPlanDatabaseListener() {
  if (unsubscribePlanDB) {
    unsubscribePlanDB();
    unsubscribePlanDB = null;
  }
  dbData = null;
  selectedWeekKey = '';
}

/* =========================================
3. 사원 로그인 / 가입 신청 / 권한 감시 컨트롤러
   ========================================= */
const tabLogin = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const pendingBox = document.getElementById('pending-box');
const authTabsWrap = document.querySelector('.auth-tabs');

function updatePlannerToolbarVisibility() {
  plannerToolbar.style.display = (isAuthorized && canEditPlan) ? 'flex' : 'none';
}

function showAuthTab(mode) {
  pendingBox.style.display = 'none';
  authTabsWrap.style.display = 'grid';
  if (mode === 'login') {
    tabLogin.classList.add('active');
    tabSignup.classList.remove('active');
    loginForm.style.display = 'flex';
    signupForm.style.display = 'none';
  } else {
    tabSignup.classList.add('active');
    tabLogin.classList.remove('active');
    signupForm.style.display = 'flex';
    loginForm.style.display = 'none';
  }
}

function showPendingApprovalUI() {
  authTabsWrap.style.display = 'none';
  loginForm.style.display = 'none';
  signupForm.style.display = 'none';
  pendingBox.style.display = 'block';
  document.getElementById('pending-user-info').innerHTML =
    `<strong>${pendingUserDisplay}</strong> 계정은 현재 승인 대기 중입니다.<br>관리자가 승인하면 자동으로 계획서가 열립니다.`;
}

function openAuthPrompt(targetLineKey) {
  pendingLine = targetLineKey;
  const lineLabel = LINE_META[targetLineKey].label;
  document.getElementById('login-target-desc').textContent =
    `${lineLabel} 생산계획서를 열람하려면 로그인하세요`;

  selectScreen.style.display = 'none';
  planScreen.style.display = 'none';
  loginScreen.style.display = 'flex';

  if (isPendingApproval) {
    showPendingApprovalUI();
  } else {
    showAuthTab('login');
  }
}

async function watchEmployeeSession(empId) {
  if (unsubscribeEmpWatch) {
    unsubscribeEmpWatch();
    unsubscribeEmpWatch = null;
  }

  if (!empId) {
    isAuthorized = false;
    canEditPlan = false;
    currentEmpInfo = null;
    isPendingApproval = false;
    updatePlannerToolbarVisibility();
    stopPlanDatabaseListener();
    return;
  }

  await authReady;

  unsubscribeEmpWatch = onValue(ref(db, `employees/${empId}`), (snap) => {
    const emp = snap.val();

    if (!emp) {
      logoutEmployee(false);
      if (planScreen.style.display === 'flex') {
        alert('등록되지 않았거나 삭제된 계정입니다.');
        backToSelect();
      } else if (loginScreen.style.display === 'flex') {
        showAuthTab('login');
      }
      return;
    }

    if (emp.active === true) {
      isAuthorized = true;
      isPendingApproval = false;
      currentEmpInfo = { empId, ...emp };
      canEditPlan = emp.canEdit === true || emp.role === 'planner' || emp.role === 'admin';
      updatePlannerToolbarVisibility();
      startPlanDatabaseListener();

      if (pendingLine !== null) {
        const target = pendingLine;
        pendingLine = null;
        openLine(target);
      }
    } else {
      isAuthorized = false;
      canEditPlan = false;
      currentEmpInfo = null;
      isPendingApproval = true;
      pendingUserDisplay = `${emp.name} (${emp.dept})`;
      updatePlannerToolbarVisibility();
      stopPlanDatabaseListener();

      if (planScreen.style.display === 'flex') {
        alert('승인 대기 중이거나 접근이 차단된 계정입니다.');
        backToSelect();
      } else if (loginScreen.style.display === 'flex') {
        showPendingApprovalUI();
      }
    }
  });
}

function logoutEmployee(askConfirm = true) {
  if (askConfirm && !confirm('로그아웃 하시겠습니까?')) return;
  localStorage.removeItem(STORAGE_EMP_KEY);
  pendingLine = null;
  isAuthorized = false;
  canEditPlan = false;
  currentEmpInfo = null;
  isPendingApproval = false;
  pendingUserDisplay = '';
  updatePlannerToolbarVisibility();
  if (unsubscribeEmpWatch) {
    unsubscribeEmpWatch();
    unsubscribeEmpWatch = null;
  }
  stopPlanDatabaseListener();
  if (planScreen.style.display === 'flex') {
    backToSelect();
  } else if (loginScreen.style.display === 'flex') {
    showAuthTab('login');
  }
}

const savedEmpId = localStorage.getItem(STORAGE_EMP_KEY);
if (savedEmpId) {
  watchEmployeeSession(savedEmpId);
}

tabLogin.addEventListener('click', () => showAuthTab('login'));
tabSignup.addEventListener('click', () => showAuthTab('signup'));

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const empId = sanitizeId(document.getElementById('login-id').value);
  const inputPw = document.getElementById('login-password').value.trim();
  const loginError = document.getElementById('login-error');
  const btnLogin = document.getElementById('btn-login');

  loginError.textContent = '';
  btnLogin.disabled = true;

  try {
    await authReady;
    const snap = await get(ref(db, `employees/${empId}`));
    const emp = snap.val();

    if (!emp || String(emp.password) !== inputPw) {
      loginError.textContent = '사번 또는 비밀번호가 올바르지 않습니다.';
      return;
    }

    localStorage.setItem(STORAGE_EMP_KEY, empId);
    loginForm.reset();
    watchEmployeeSession(empId);
  } catch (err) {
    loginError.textContent = '로그인 중 오류가 발생했습니다.';
  } finally {
    btnLogin.disabled = false;
  }
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('signup-name').value.trim();
  const dept = document.getElementById('signup-dept').value;
  const empId = sanitizeId(document.getElementById('signup-id').value);
  const password = document.getElementById('signup-password').value.trim();
  const signupError = document.getElementById('signup-error');
  const btnSignup = document.getElementById('btn-signup');

  signupError.textContent = '';
  btnSignup.disabled = true;

  try {
    await authReady;
    const existingSnap = await get(ref(db, `employees/${empId}`));
    if (existingSnap.exists()) {
      signupError.textContent = '이미 등록되었거나 신청 중인 사번입니다.';
      return;
    }

    await set(ref(db, `employees/${empId}`), {
      name,
      dept,
      password,
      active: false,
      canEdit: false,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    localStorage.setItem(STORAGE_EMP_KEY, empId);
    signupForm.reset();
    watchEmployeeSession(empId);
  } catch (err) {
    signupError.textContent = '신청 중 오류가 발생했습니다.';
  } finally {
    btnSignup.disabled = false;
  }
});

document.getElementById('btn-pending-refresh').addEventListener('click', () => window.location.reload());
document.getElementById('btn-pending-logout').addEventListener('click', () => logoutEmployee(false));
document.getElementById('btn-login-cancel').addEventListener('click', () => {
  pendingLine = null;
  loginScreen.style.display = 'none';
  selectScreen.style.display = 'flex';
});

document.getElementById('btn-logout-plan').addEventListener('click', () => logoutEmployee(true));

function openLine(lineKey, keepDayIdx = null) {
  if (!isAuthorized) {
    openAuthPrompt(lineKey);
    return;
  }

  loginScreen.style.display = 'none';
  selectScreen.style.display = 'none';
  planScreen.style.display = 'flex';
  lineSelectEl.value = String(lineKey);
  updatePlannerToolbarVisibility();
  planRenderer.loadLine(lineKey, keepDayIdx);
}

function backToSelect() {
  planRenderer.destroy();
  loginScreen.style.display = 'none';
  planScreen.style.display = 'none';
  selectScreen.style.display = 'flex';
}

document.getElementById('btn-line-imprinting').addEventListener('click', () => openLine('imprinting'));
document.getElementById('btn-line-1').addEventListener('click', () => openLine(1));
document.getElementById('btn-line-2').addEventListener('click', () => openLine(2));
document.getElementById('btn-prev-day').addEventListener('click', () => planRenderer.step(-1));
document.getElementById('btn-next-day').addEventListener('click', () => planRenderer.step(1));
document.getElementById('btn-today').addEventListener('click', () => {
  if (!dbData || !dbData.weeks) return;

  const today = new Date();
  const currentWeekKey = findCurrentWeekKey(dbData.weeks);
  if (!currentWeekKey) return;

  selectedWeekKey = currentWeekKey;
  weekSelectEl.value = currentWeekKey;

  // 월요일(1) ~ 일요일(7) 기준 인덱스 계산 (JS getDay(): 일=0, 월=1 ... 토=6)
  const jsDay = today.getDay();
  const todayIdx = jsDay === 0 ? 7 : jsDay;

  planRenderer.loadLine(planRenderer.currentLine, todayIdx);
});

lineSelectEl.addEventListener('change', (e) => {
  openLine(e.target.value, planRenderer.currentDayIdx);
});

weekSelectEl.addEventListener('change', (e) => {
  selectedWeekKey = e.target.value;
  planRenderer.loadLine(planRenderer.currentLine, planRenderer.currentDayIdx);
});

/* =========================================
4. 권한자 전용: 주간 계획 생성 & 수동 수정 모달
   ========================================= */
const editModal = document.getElementById('plan-edit-modal');
const editModalTitle = document.getElementById('edit-modal-title');
const editModalTbody = document.getElementById('edit-modal-tbody');
let editingItems = [];

function renderEditModalRows() {
  if (editingItems.length === 0) {
    editModalTbody.innerHTML = `<tr><td colspan="6" style="padding:20px; color:#64748b;">항목이 없습니다. 아래 [➕ 행 추가]를 눌러 계획을 입력하세요.</td></tr>`;
    return;
  }

  editModalTbody.innerHTML = editingItems.map((item, idx) => `
    <tr>
      <td><input type="text" data-idx="${idx}" data-field="seq" value="${escapeHtml(item.seq ?? idx + 1)}" /></td>
      <td><textarea rows="2" data-idx="${idx}" data-field="name" placeholder="품명 및 사양 (Enter로 줄바꿈)">${escapeHtml(item.name)}</textarea></td>
      <td><input type="text" data-idx="${idx}" data-field="qty" value="${escapeHtml(item.qty)}" placeholder="예: 8,500M" /></td>
      <td><input type="text" data-idx="${idx}" data-field="process" value="${escapeHtml(item.process)}" placeholder="예: 인쇄" /></td>
      <td><textarea rows="2" data-idx="${idx}" data-field="note" placeholder="특이사항 (Enter로 줄바꿈)">${escapeHtml(item.note)}</textarea></td>
      <td><button type="button" class="tool-btn danger" data-del-idx="${idx}">삭제</button></td>
    </tr>
  `).join('');
}

function syncModalInputs() {
  editModalTbody.querySelectorAll('input, textarea').forEach((el) => {
    const idx = Number(el.dataset.idx);
    const field = el.dataset.field;
    if (editingItems[idx]) {
      editingItems[idx][field] = el.value.trim();
    }
  });
}

async function createOrNavigateToWeekByMonday(mondayDate) {
  const monday = getMondayOfDate(mondayDate);
  const mondayKey = formatDateYMD(monday);

  if (dbData && dbData.weeks && dbData.weeks[mondayKey]) {
    selectedWeekKey = mondayKey;
    renderWeekOptions(dbData.weeks);
    planRenderer.loadLine(planRenderer.currentLine, planRenderer.currentDayIdx);
    alert(`이미 생성된 일정입니다. [${dbData.weeks[mondayKey].period}] 화면으로 이동합니다.`);
    return;
  }

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startYear = monday.getFullYear();
  const endYear = sunday.getFullYear();
  const periodStr = startYear === endYear
    ? `${startYear}년 ${monday.getMonth() + 1}월 ${monday.getDate()}일 ~ ${sunday.getMonth() + 1}월 ${sunday.getDate()}일`
    : `${startYear}년 ${monday.getMonth() + 1}월 ${monday.getDate()}일 ~ ${endYear}년 ${sunday.getMonth() + 1}월 ${sunday.getDate()}일`;

  if (!confirm(`[${periodStr}]\n생산계획서 일정을 새로 생성하시겠습니까?`)) {
    return;
  }

  const buildEmptyDays = () => {
    const arr = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      arr.push({
        date: formatDateYMD(d),
        dayLabel: `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAY_NAMES_KO[d.getDay()]})`,
        items: []
      });
    }
    return arr;
  };

  const newWeekObj = {
    year: monday.getFullYear(),
    month: monday.getMonth() + 1,
    period: periodStr,
    lines: {
      '1': buildEmptyDays(),
      '2': buildEmptyDays(),
      'imprinting': buildEmptyDays()
    }
  };

  try {
    await authReady;
    await set(ref(db, `/production-plan/weeks/${mondayKey}`), newWeekObj);

    if (!dbData) dbData = { weeks: {} };
    if (!dbData.weeks) dbData.weeks = {};
    dbData.weeks[mondayKey] = newWeekObj;
    selectedWeekKey = mondayKey;

    renderWeekOptions(dbData.weeks);
    planRenderer.loadLine(planRenderer.currentLine, planRenderer.currentDayIdx);

    alert(`[${periodStr}] 일정이 생성되었습니다. 이제 엑셀 파일을 업로드하거나 수동 입력할 수 있습니다.`);
  } catch (err) {
    console.error('일정 생성 실패:', err);
    alert('일정을 생성하는 중 오류가 발생했습니다.');
  }
}

document.getElementById('btn-add-next-week').addEventListener('click', async () => {
  if (!canEditPlan) return;

  const sortedKeys = getSortedWeekKeys(dbData ? dbData.weeks : {});
  let nextMonday;

  if (sortedKeys.length > 0) {
    const lastMondayKey = sortedKeys[sortedKeys.length - 1];
    nextMonday = parseLocalDateStr(lastMondayKey);
    nextMonday.setDate(nextMonday.getDate() + 7);
  } else {
    nextMonday = getMondayOfDate(new Date());
  }

  await createOrNavigateToWeekByMonday(nextMonday);
});

document.getElementById('btn-open-manual-edit').addEventListener('click', () => {
  if (!canEditPlan || !dbData || !dbData.weeks || !dbData.weeks[selectedWeekKey]) return;

  const lineKey = String(planRenderer.currentLine);
  const dayIdx = planRenderer.currentDayIdx - 1;
  const days = planRenderer.getDaysFromDB(lineKey);
  const targetDay = days[dayIdx];

  if (!targetDay) {
    alert('수정할 날짜 데이터를 찾을 수 없습니다.');
    return;
  }

  const lineLabel = LINE_META[lineKey].label;
  editModalTitle.textContent = `✏️ ${lineLabel} — ${targetDay.dayLabel} 수동 수정`;
  editingItems = JSON.parse(JSON.stringify(targetDay.items || []));
  renderEditModalRows();
  editModal.style.display = 'flex';
});

document.getElementById('btn-modal-add-row').addEventListener('click', () => {
  syncModalInputs();
  editingItems.push({
    seq: String(editingItems.length + 1),
    name: '',
    qty: '',
    process: '',
    note: ''
  });
  renderEditModalRows();
});

editModalTbody.addEventListener('click', (e) => {
  const delIdx = e.target.dataset.delIdx;
  if (delIdx === undefined) return;
  syncModalInputs();
  editingItems.splice(Number(delIdx), 1);
  renderEditModalRows();
});

function closeEditModal() {
  editModal.style.display = 'none';
  editingItems = [];
}

document.getElementById('btn-close-edit-modal').addEventListener('click', closeEditModal);
document.getElementById('btn-modal-cancel').addEventListener('click', closeEditModal);

document.getElementById('btn-modal-save').addEventListener('click', async () => {
  if (!canEditPlan || !selectedWeekKey) return;
  syncModalInputs();

  const cleanedItems = editingItems
    .filter(item => item.name || item.qty || item.process || item.note)
    .map((item, idx) => ({
      ...(item.workStatus ? { workStatus: item.workStatus } : {}),
      ...(Array.isArray(item.timeLogs) ? { timeLogs: item.timeLogs } : {}),
      seq: item.seq || String(idx + 1),
      name: item.name || '',
      qty: item.qty || '',
      process: item.process || '-',
      note: item.note || ''
    }));

  const lineKey = String(planRenderer.currentLine);
  const dayIdx = planRenderer.currentDayIdx - 1;
  const days = JSON.parse(JSON.stringify(planRenderer.getDaysFromDB(lineKey)));

  if (!days[dayIdx]) return;
  days[dayIdx].items = cleanedItems;
  delete days[dayIdx].imageUrl;

  try {
    await authReady;
    await set(ref(db, `/production-plan/weeks/${selectedWeekKey}/lines/${lineKey}`), days);
    dbData.weeks[selectedWeekKey].lines[lineKey] = days;

    await syncLatestTemplateFile(dbData, selectedWeekKey, lineKey, days);

    closeEditModal();
    alert('생산계획서가 저장되었습니다.');
  } catch (err) {
    console.error('수동 저장 실패:', err);
    alert('저장 중 오류가 발생했습니다. 권한 또는 네트워크를 확인해 주세요.');
  }
});

// 엑셀 업로드/다운로드 핸들러 초기화
initExcelSyncHandlers({
  getState: getAppState,
  setSelectedWeekKey: (val) => { selectedWeekKey = val; },
  planRenderer,
  weekSelectEl
});

/* =========================================
5. 주간 통합생산계획서 전체보기 모달
   ========================================= */
const overviewModal = document.getElementById('weekly-overview-modal');
const overviewModalTitle = document.getElementById('overview-modal-title');
const overviewModalBody = document.getElementById('overview-modal-body');

function renderWeeklyOverviewTable() {
  const weekObj = dbData?.weeks?.[selectedWeekKey];
  if (!weekObj) {
    alert('표시할 주간 일정 데이터가 없습니다.');
    return;
  }

  const lineConfigs = [
    { key: '1', label: '1호기' },
    { key: '2', label: '2호기' },
    { key: 'imprinting', label: '임프린팅' }
  ];

  const days1 = planRenderer.getDaysFromDB('1');
  const days2 = planRenderer.getDaysFromDB('2');
  const daysImp = planRenderer.getDaysFromDB('imprinting');
  const baseDays = days1.length ? days1 : (days2.length ? days2 : daysImp);

  overviewModalTitle.textContent = `📋 ${weekObj.period || selectedWeekKey} 주간 통합생산계획서`;

  // 헤더 1행: 라인 + 7일 (날짜 / 공정)
  let headerHtml = `<tr><th class="col-line">라인</th>`;
  for (let d = 0; d < 7; d++) {
    const dayInfo = baseDays[d];
    let colLabel = dayInfo?.dayLabel || `${d + 1}일차`;
    if (dayInfo?.date && /^\d{4}-\d{2}-\d{2}$/.test(dayInfo.date)) {
      const mm = Number(dayInfo.date.slice(5, 7));
      const dd = Number(dayInfo.date.slice(8, 10));
      const shortDay = (dayInfo.dayLabel || '').replace(/요일/, '').slice(-2).replace(/[()]/g, '').trim();
      colLabel = `${mm}/${dd}${shortDay ? ` (${shortDay})` : ''}`;
    }
    headerHtml += `<th>${escapeHtml(colLabel)}</th><th>공정</th>`;
  }
  headerHtml += `</tr>`;

  // 본문: 엑셀 양식 순서(1호기 -> 2호기 -> 임프린팅)로 행 생성
  let bodyHtml = '';
  lineConfigs.forEach((cfg) => {
    const lineDays = planRenderer.getDaysFromDB(cfg.key);
    const maxRows = Math.max(
      1,
      ...Array.from({ length: 7 }, (_, d) => (lineDays[d]?.items || []).length)
    );

    for (let r = 0; r < maxRows; r++) {
      const isLastRow = r === maxRows - 1;
      bodyHtml += `<tr class="${isLastRow ? 'line-group-end' : ''}">`;

      if (r === 0) {
        bodyHtml += `<td class="col-line" rowspan="${maxRows}">${escapeHtml(cfg.label)}</td>`;
      }

      for (let d = 0; d < 7; d++) {
        const item = lineDays[d]?.items?.[r];
        if (item && (item.name || item.qty || item.note)) {
          const seqPrefix = item.seq && item.seq !== '-' ? `${item.seq}. ` : `${r + 1}. `;
          const qtySuffix = item.qty && item.qty !== '-' ? ` ${item.qty}` : '';
          const statusTag =
            item.workStatus === 'running' ? `<span class="ov-status-dot running">진행중</span>`
            : item.workStatus === 'paused' ? `<span class="ov-status-dot paused">중단</span>`
            : item.workStatus === 'completed' ? `<span class="ov-status-dot completed">완료</span>`
            : '';

          bodyHtml += `
            <td class="col-plan">
              <div class="ov-item-title">${escapeHtml(`${seqPrefix}${item.name || ''}${qtySuffix}`)}${statusTag}</div>
              ${item.note ? `<div class="ov-item-note">※ ${escapeHtml(item.note)}</div>` : ''}
            </td>
            <td class="col-proc">${escapeHtml(item.process && item.process !== '-' ? item.process : '')}</td>
          `;
        } else {
          bodyHtml += `<td class="col-plan"></td><td class="col-proc"></td>`;
        }
      }

      bodyHtml += `</tr>`;
    }
  });

  overviewModalBody.innerHTML = `
    <table class="overview-table">
      <thead>${headerHtml}</thead>
      <tbody>${bodyHtml}</tbody>
    </table>
  `;
  overviewModal.style.display = 'flex';
}

const overviewModalCard = overviewModal?.querySelector('.overview-modal-card');
const btnToggleOverviewRotate = document.getElementById('btn-toggle-overview-rotate');

function closeOverviewModal() {
  overviewModal.style.display = 'none';
  overviewModalBody.innerHTML = '';
  overviewModalCard?.classList.remove('force-landscape');
  if (btnToggleOverviewRotate) btnToggleOverviewRotate.textContent = '🔄 가로로 보기';
}

btnToggleOverviewRotate?.addEventListener('click', () => {
  if (!overviewModalCard) return;
  const isRotated = overviewModalCard.classList.toggle('force-landscape');
  btnToggleOverviewRotate.textContent = isRotated ? '📱 세로로 복귀' : '🔄 가로로 보기';
});

document.getElementById('btn-weekly-overview')?.addEventListener('click', renderWeeklyOverviewTable);
document.getElementById('btn-close-overview-modal')?.addEventListener('click', closeOverviewModal);
document.getElementById('btn-overview-close-bottom')?.addEventListener('click', closeOverviewModal);
overviewModal?.addEventListener('click', (e) => {
  if (e.target === overviewModal) closeOverviewModal();
});

/* =========================================
6. PWA 설치 프롬프트 처리
   ========================================= */
let deferredPrompt;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = 'block';
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt = null;
  installBtn.style.display = 'none';
});