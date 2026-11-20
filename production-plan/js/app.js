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
  findCurrentWeekKey,
  getMonthWeekNumberByEndDate
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
const weekSelectEl = document.getElementById('week-select');
const btnLogoutSelect = document.getElementById('btn-logout-select');
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
    const mPrefix = w.month ? `${w.month}월 ` : '';
    const shortPeriod = w.period ? w.period.split(' ').slice(1).join(' ') : key;
    return `<option value="${key}">${mPrefix}${w.week}주차 (${shortPeriod})</option>`;
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
  if (plannerToolbar) {
    plannerToolbar.style.display = (isAuthorized && canEditPlan) ? 'flex' : 'none';
  }
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
  const lineLabel = LINE_META[targetLineKey]?.label || '';
  const descEl = document.getElementById('login-target-desc');
  if (descEl) {
    descEl.textContent = `${lineLabel} 생산계획서를 열람하려면 로그인하세요`;
  }

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
    btnLogoutSelect.style.display = 'none';
    updatePlannerToolbarVisibility();
    stopPlanDatabaseListener();
    return;
  }

  await authReady;
  btnLogoutSelect.style.display = 'block';

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
  btnLogoutSelect.style.display = 'none';
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

btnLogoutSelect.addEventListener('click', () => logoutEmployee(true));
document.getElementById('btn-logout-plan').addEventListener('click', () => logoutEmployee(true));

function openLine(lineKey, keepDayIdx = null) {
  if (!isAuthorized) {
    openAuthPrompt(lineKey);
    return;
  }

  loginScreen.style.display = 'none';
  selectScreen.style.display = 'none';
  planScreen.style.display = 'flex';
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
document.getElementById('btn-back').addEventListener('click', backToSelect);
document.getElementById('btn-prev-day').addEventListener('click', () => planRenderer.step(-1));
document.getElementById('btn-next-day').addEventListener('click', () => planRenderer.step(1));
document.getElementById('btn-switch-line').addEventListener('click', () => {
  const nextLine = LINE_META[planRenderer.currentLine].next;
  openLine(nextLine, planRenderer.currentDayIdx);
});

weekSelectEl.addEventListener('change', (e) => {
  selectedWeekKey = e.target.value;
  planRenderer.loadLine(planRenderer.currentLine, planRenderer.currentDayIdx);
});

/* =========================================
4. 권한자 전용: 주차 생성 & 수동 수정 모달
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

  if (dbData?.weeks?.[mondayKey]) {
    selectedWeekKey = mondayKey;
    renderWeekOptions(dbData.weeks);
    planRenderer.loadLine(planRenderer.currentLine, planRenderer.currentDayIdx);
    alert(`이미 생성된 주차입니다. [${dbData.weeks[mondayKey].period}] 화면으로 이동합니다.`);
    return;
  }

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const { year, month, weekOfMonth } = getMonthWeekNumberByEndDate(monday);
  const startYear = monday.getFullYear();
  const endYear = sunday.getFullYear();
  const periodStr = startYear === endYear
    ? `${startYear}년 ${monday.getMonth() + 1}월 ${monday.getDate()}일 ~ ${sunday.getMonth() + 1}월 ${sunday.getDate()}일`
    : `${startYear}년 ${monday.getMonth() + 1}월 ${monday.getDate()}일 ~ ${endYear}년 ${sunday.getMonth() + 1}월 ${sunday.getDate()}일`;

  if (!confirm(`[${year}년 ${month}월 ${weekOfMonth}주차]\n(${periodStr})\n생산계획서 주차를 새로 생성하시겠습니까?`)) {
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
    year,
    month,
    week: weekOfMonth,
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

    alert(`[${year}년 ${month}월 ${weekOfMonth}주차]가 생성되었습니다. 이제 엑셀 파일을 업로드하거나 수동 입력할 수 있습니다.`);
  } catch (err) {
    console.error('주차 생성 실패:', err);
    alert('주차를 생성하는 중 오류가 발생했습니다.');
  }
}

document.getElementById('btn-add-next-week')?.addEventListener('click', async () => {
  if (!canEditPlan) return;

  const sortedKeys = getSortedWeekKeys(dbData?.weeks);
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

const customDateInput = document.getElementById('custom-week-date-input');
document.getElementById('btn-pick-custom-week')?.addEventListener('click', () => {
  if (!canEditPlan || !customDateInput) return;
  if (typeof customDateInput.showPicker === 'function') {
    customDateInput.showPicker();
  } else {
    customDateInput.click();
  }
});

customDateInput?.addEventListener('change', async (e) => {
  if (!e.target.value || !canEditPlan) return;
  const pickedDate = parseLocalDateStr(e.target.value);
  e.target.value = '';
  await createOrNavigateToWeekByMonday(pickedDate);
});

document.getElementById('btn-open-manual-edit').addEventListener('click', () => {
  if (!canEditPlan || !dbData?.weeks?.[selectedWeekKey]) return;

  const lineKey = String(planRenderer.currentLine);
  const dayIdx = planRenderer.currentDayIdx - 1;
  const days = planRenderer.getDaysFromDB(lineKey);
  const targetDay = days[dayIdx];

  if (!targetDay) {
    alert('수정할 날짜 데이터를 찾을 수 없습니다.');
    return;
  }

  const lineLabel = LINE_META[lineKey]?.label || lineKey;
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
  const delIdx = e.target.dataset?.delIdx;
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
5. PWA 설치 프롬프트 처리
   ========================================= */
let deferredPrompt;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.style.display = 'block';
});

installBtn?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt = null;
  installBtn.style.display = 'none';
});