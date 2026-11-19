import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase, ref, get, set, onValue } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

/* =========================================
0. Firebase 초기화 및 백그라운드 익명 인증
   ========================================= */
const firebaseConfig = {
  apiKey: "AIzaSyBUsI3yLBdZQmOTrld-AdioO4Wwvy08qwU",
  databaseURL: "https://idc-office-default-rtdb.firebaseio.com",
  projectId: "idc-office"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const authReady = signInAnonymously(auth).catch((err) => {
  console.error("백그라운드 익명 인증 실패:", err);
});

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
2. 라인 정보 및 전역 상태 관리 (YYYY-MM-DD 키 기반)
   ========================================= */
const LINE_META = {
  imprinting: { label: '임프린팅', next: 1 },
  1: { label: '1호기', next: 2 },
  2: { label: '2호기', next: 'imprinting' }
};

const DAY_NAMES_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const STORAGE_EMP_KEY = 'idc_logged_in_emp_id';

let dbData = null;             // Firebase /production-plan 데이터 ({ weeks: { "YYYY-MM-DD": weekObj } })
let selectedWeekKey = '';      // 현재 선택된 월요일 날짜 키 ("YYYY-MM-DD")
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

function sanitizeId(rawId) {
  return rawId.trim().replace(/[.#$\[\]\/]/g, '_');
}

function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function parseLocalDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateYMD(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMondayOfDate(dateObj) {
  const diffToMon = (dateObj.getDay() + 6) % 7;
  return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate() - diffToMon);
}

// YYYY-MM-DD 키만 정렬해서 반환
function getSortedWeekKeys(weeksObj) {
  if (!weeksObj || typeof weeksObj !== 'object') return [];
  return Object.keys(weeksObj)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && weeksObj[k])
    .sort();
}

function findCurrentWeekKey(weeksObj) {
  const keys = getSortedWeekKeys(weeksObj);
  if (keys.length === 0) return '';

  const thisMondayKey = formatDateYMD(getMondayOfDate(new Date()));
  if (keys.includes(thisMondayKey)) return thisMondayKey;

  return keys[keys.length - 1];
}

function renderWeekOptions(weeksObj) {
  const allKeys = getSortedWeekKeys(weeksObj);
  if (allKeys.length === 0) {
    weekSelectEl.innerHTML = '';
    return;
  }

  // 오늘 기준 8주(56일) 전 월요일 날짜 계산
  const cutoffDate = getMondayOfDate(new Date());
  cutoffDate.setDate(cutoffDate.getDate() - 56);
  const cutoffKey = formatDateYMD(cutoffDate);

  // 최근 8주 이후 + 미래 주차만 노출 (모두 8주 이전 데이터뿐이라면 최신 8주 유지)
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
3. 좌우 무한 루프 날짜 슬라이더 렌더러
   ========================================= */
class InfinitePlanRenderer {
  constructor(viewportId) {
    this.viewport = document.getElementById(viewportId);
    this.slider = null;
    this.days = [];
    this.currentLine = 'imprinting';
    this.currentDayIdx = 1;
    this.isAnimating = false;
    this.ANIM_TIME = 400;
    this.eventListeners = [];
  }

  getDaysFromDB(lineKey) {
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

  loadLine(lineKey, keepDayIdx = null) {
    this.destroy();
    this.currentLine = lineKey;

    const meta = LINE_META[lineKey];
    const nextMeta = LINE_META[meta.next];
    const weekObj = dbData?.weeks?.[selectedWeekKey];
    const weekTitle = weekObj ? `${weekObj.week}주차` : '주차 없음';

    document.getElementById('current-header-title').textContent = `${meta.label} 생산계획서 (${weekTitle})`;
    document.getElementById('btn-switch-line').textContent = `${nextMeta.label} 전환`;

    if (!dbData) {
      this.viewport.innerHTML = `<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#475569;font-weight:700;">데이터를 불러오는 중입니다...</div>`;
      return;
    }

    if (!weekObj) {
      this.viewport.innerHTML = `<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#475569;font-weight:700;">생성된 주차가 없습니다. 상단 [➕ 다음 주차 생성]을 눌러 시작하세요.</div>`;
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
    this.updatePlannerStatusLabel();
    this.initEvents();
  }

  updatePlannerStatusLabel() {
    const labelEl = document.getElementById('planner-status-text');
    if (!labelEl || !this.days.length) return;
    const dayObj = this.days[this.currentDayIdx - 1];
    const lineLabel = LINE_META[this.currentLine]?.label || '';
    if (dayObj) {
      labelEl.textContent = `${lineLabel} · ${dayObj.dayLabel}`;
    }
  }

  createSlideElement(dayData) {
    const slide = document.createElement('section');
    slide.className = 'day-slide';
    const lineLabel = LINE_META[this.currentLine].label;

    let contentHtml = '';
    if (dayData.imageUrl) {
      contentHtml = `
        <div class="sheet-image-wrap">
          <img src="${dayData.imageUrl}" alt="${dayData.dayLabel} 생산계획서" />
        </div>
      `;
    } else {
      const items = dayData.items || [];
      const rows = items.length > 0
        ? items
        : [{ seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-', note: '' }];

      const rowsHtml = rows.map((r) => `
        <tr>
          <td><strong>${escapeHtml(r.seq ?? '-')}</strong></td>
          <td style="text-align:left; padding-left:16px;">
            <strong style="white-space: pre-line;">${escapeHtml(r.name || '-')}</strong>
            ${r.note ? `<div style="font-size:0.8em; color:#64748b; margin-top:4px; font-weight:500; white-space: pre-line;">※ ${escapeHtml(r.note)}</div>` : ''}
          </td>
          <td><strong>${escapeHtml(r.qty || '-')}</strong></td>
          <td>
            <span class="process-badge ${!r.process || r.process === '-' ? 'process-empty' : ''}">
              ${escapeHtml(r.process || '-')}
            </span>
          </td>
        </tr>
      `).join('');

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
      <div class="day-banner">
        <h2>📅 ${lineLabel} — ${dayData.dayLabel}</h2>
        <span class="swipe-hint">◀ 좌우로 밀거나 휠을 돌려 날짜 이동 ▶</span>
      </div>
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

    const firstClone = this.createSlideElement(this.days[0]);
    const lastClone = this.createSlideElement(this.days[this.days.length - 1]);

    slider.append(lastClone);
    this.days.forEach(day => slider.append(this.createSlideElement(day)));
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
        this.updatePlannerStatusLabel();
        this.isAnimating = false;
      }, this.ANIM_TIME);
      return;
    }

    this.updatePlannerStatusLabel();
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
    this.addListener(this.viewport, 'wheel', (e) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) > 20) {
        this.step(delta > 0 ? 1 : -1);
      }
    }, { passive: true });

    let isMouseDown = false;
    let startX = 0;

    this.addListener(this.viewport, 'mousedown', (e) => {
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
      if (e.touches.length > 1) return;
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    this.addListener(this.viewport, 'touchend', (e) => {
      if (e.touches.length > 0) return;
      const dx = touchStartX - e.changedTouches[0].clientX;
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

/* =========================================
4. 익명 인증 기반 사원 로그인 / 가입 신청 / 권한 감시 컨트롤러
   ========================================= */
const planRenderer = new InfinitePlanRenderer('plan-viewport');

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
5. 권한자 전용: 수동 수정 모달 & 원본 서식 즉시 동기화 엑셀 업로드/다운로드
   ========================================= */
const editModal = document.getElementById('plan-edit-modal');
const editModalTitle = document.getElementById('edit-modal-title');
const editModalTbody = document.getElementById('edit-modal-tbody');
let editingItems = [];

// 월요일 날짜(YYYY-MM-DD) 기반 고유 템플릿 키
function getWeekTemplateKey(weekKey = selectedWeekKey) {
  return `week_${weekKey}`.replace(/[.#$\[\]\/\s~()]/g, '_');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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

// =========================================
// [권한자 전용] 다음 주차 자동 생성 기능 (YYYY-MM-DD 키 저장)
// =========================================
// 해당 주의 마지막 날(일요일) 기준으로 소속 월과 주차 산출
function getMonthWeekNumberByEndDate(mondayDate) {
  const sunday = new Date(mondayDate);
  sunday.setDate(mondayDate.getDate() + 6);

  const year = sunday.getFullYear();
  const month = sunday.getMonth() + 1;
  const firstDayOfMonth = new Date(year, sunday.getMonth(), 1);
  const weekOfMonth = Math.ceil((sunday.getDate() + firstDayOfMonth.getDay()) / 7);

  return { year, month, weekOfMonth };
}

// 공통 주차 생성 및 이동 함수
async function createOrNavigateToWeekByMonday(mondayDate) {
  const monday = getMondayOfDate(mondayDate);
  const mondayKey = formatDateYMD(monday);

  // 이미 존재하는 주차면 새로 만들지 않고 해당 주차로 이동
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

// 1) [➕ 다음 주차 생성]: 등록된 가장 마지막 주차의 다음 주 월요일 자동 계산
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

// 2) [📅 특정 주 생성]: 달력에서 날짜 선택 시 해당 주(월~일) 생성 또는 이동
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

// 현재 보고 있는 일자의 수동 수정 모달 열기
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

// =========================================
// 통합생산계획서 양식 파싱 및 원본 템플릿 즉시 동기화 헬퍼
// =========================================
function parseExcelPlanCell(rawText, processText, fallbackSeq) {
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

function detectLineKeyFromCell(cellVal) {
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

async function syncLatestTemplateFile(weekKey, overrideLineKey = null, overrideDays = null) {
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

// 수동 수정 내용 Firebase DB 저장 + 원본 템플릿 완성본 즉시 덮어쓰기
document.getElementById('btn-modal-save').addEventListener('click', async () => {
  if (!canEditPlan || !selectedWeekKey) return;
  syncModalInputs();

  const cleanedItems = editingItems
    .filter(item => item.name || item.qty || item.process || item.note)
    .map((item, idx) => ({
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

    await syncLatestTemplateFile(selectedWeekKey, lineKey, days);

    closeEditModal();
    alert('생산계획서가 저장되었습니다.');
  } catch (err) {
    console.error('수동 저장 실패:', err);
    alert('저장 중 오류가 발생했습니다. 권한 또는 네트워크를 확인해 주세요.');
  }
});

// 폴백 엑셀 생성기
function downloadFallbackPlainExcel(weekObj, yearStr, monthNum) {
  const days1 = planRenderer.getDaysFromDB('1');
  const days2 = planRenderer.getDaysFromDB('2');
  const daysImp = planRenderer.getDaysFromDB('imprinting');
  const baseDays = days1.length ? days1 : (days2.length ? days2 : daysImp);

  const titleText = `${yearStr}년  ${monthNum} 월  ${weekObj.week} 주차 주간 통합생산계획서`;
  const aoa = [
    [titleText, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    new Array(16).fill(null),
    [null, null, null, null, null, null, null, null, `   ${weekObj.period || ''}`, null, null, null, null, null, null, null],
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

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `${monthNum}월 ${weekObj.week}주`);
  XLSX.writeFile(wb, `IDC_주간통합생산계획서_${yearStr}년_${monthNum}월_${weekObj.week}주차.xlsx`);
}

// 1) [주간 엑셀 받기]
document.getElementById('btn-excel-download').addEventListener('click', async () => {
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
      downloadFallbackPlainExcel(weekObj, yearStr, monthNum);
      return;
    }

    let downloadBase64 = tplData.latestBase64;
    if (!downloadBase64) {
      const synced = await syncLatestTemplateFile(selectedWeekKey);
      downloadBase64 = synced?.latestBase64;
    }

    if (!downloadBase64) {
      downloadFallbackPlainExcel(weekObj, yearStr, monthNum);
      return;
    }

    const blob = new Blob([base64ToUint8Array(downloadBase64)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = tplData.fileName || `IDC_주간통합생산계획서_${yearStr}년_${monthNum}월_${weekObj.week}주차.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('엑셀 다운로드 실패:', err);
    alert('엑셀 파일을 내려받는 중 오류가 발생했습니다.');
  }
});

// 2) [주간 엑셀 업로드]
document.getElementById('excel-upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !canEditPlan) return;

  if (weekSelectEl && weekSelectEl.value) {
    selectedWeekKey = weekSelectEl.value;
  }

  const weekObj = dbData?.weeks?.[selectedWeekKey];
  if (!weekObj) {
    alert('선택된 주차 정보를 찾을 수 없습니다. 먼저 주차를 생성해 주세요.');
    e.target.value = '';
    return;
  }

  if (!confirm(`[${weekObj.week}주차] 전체 라인(1호기 · 2호기 · 임프린팅) 생산계획을 선택한 통합 엑셀 파일로 일괄 업데이트하시겠습니까?\n(업로드한 양식 서식도 함께 보관됩니다)`)) {
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
      if (horizontalMergedRows.has(r)) {
        break;
      }

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

    alert(`총 ${totalImported}건의 생산계획과 원본 양식 서식이 [${weekObj.week}주차]에 반영되었습니다.`);
  } catch (err) {
    console.error('통합 엑셀 업로드 실패:', err);
    alert('엑셀 파일을 처리하는 중 오류가 발생했습니다.');
  } finally {
    e.target.value = '';
  }
});

/* =========================================
6. PWA 설치 프롬프트 처리
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