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

// 보안 규칙(auth != null) 통과를 위한 백그라운드 익명 인증
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
2. 라인 정보 및 전역 상태 관리
   ========================================= */
const LINE_META = {
  imprinting: { label: '임프린팅', next: 1 },
  1: { label: '1호기', next: 2 },
  2: { label: '2호기', next: 'imprinting' }
};

const STORAGE_EMP_KEY = 'idc_logged_in_emp_id';

let dbData = null;           // Firebase에서 받아온 /production-plan 전체 JSON 데이터
let selectedWeekIdx = 0;     // 현재 선택된 weeks 배열의 인덱스
let unsubscribePlanDB = null;
let unsubscribeEmpWatch = null;

let isAuthorized = false;
let isPendingApproval = false;
let pendingUserDisplay = '';
let pendingLine = null;

const loginScreen = document.getElementById('login-screen');
const selectScreen = document.getElementById('select-screen');
const planScreen = document.getElementById('plan-screen');
const weekSelectEl = document.getElementById('week-select');
const btnLogoutSelect = document.getElementById('btn-logout-select');

function sanitizeId(rawId) {
  return rawId.trim().replace(/[.#$\[\]\/]/g, '_');
}

// 오늘 날짜(YYYY-MM-DD)가 포함된 주차를 자동으로 찾기
function findCurrentWeekIndex(weeks) {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const foundIdx = weeks.findIndex(w => {
    const days = w.lines?.['1'] || w.lines?.['2'] || w.lines?.['imprinting'] || [];
    return days.some(d => d.date === todayStr);
  });

  return foundIdx !== -1 ? foundIdx : Math.max(0, weeks.length - 1);
}

// 주차 드롭다운 옵션 생성
function renderWeekOptions(weeks) {
  weekSelectEl.innerHTML = weeks.map((w, idx) => `
    <option value="${idx}">${w.week}주차 (${w.period.split(' ')[1]}~)</option>
  `).join('');
  weekSelectEl.value = String(selectedWeekIdx);
}

// 승인된 사원일 때만 /production-plan 실시간 구독 시작
async function startPlanDatabaseListener() {
  if (unsubscribePlanDB) return;
  await authReady;

  const planRef = ref(db, '/production-plan');
  unsubscribePlanDB = onValue(planRef, (snapshot) => {
    const val = snapshot.val();
    if (!val || !val.weeks) return;

    const isFirstLoad = dbData === null;
    dbData = val;

    if (isFirstLoad) {
      selectedWeekIdx = findCurrentWeekIndex(dbData.weeks);
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
    this.currentDayIdx = 1; // 1 ~ days.length (0과 length+1은 무한루프용 클론)
    this.isAnimating = false;
    this.ANIM_TIME = 400;
    this.eventListeners = [];
  }

  getDaysFromDB(lineKey) {
    if (!dbData || !dbData.weeks || !dbData.weeks[selectedWeekIdx]) {
      return [];
    }
    const weekObj = dbData.weeks[selectedWeekIdx];
    const lineDays = weekObj.lines?.[String(lineKey)];

    // DB에 해당 라인 데이터가 아직 없으면 월~일 기본 빈 배열 생성
    if (!lineDays || lineDays.length === 0) {
      const refDays = weekObj.lines?.['1'] || weekObj.lines?.['2'] || [];
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
    const weekObj = dbData?.weeks?.[selectedWeekIdx];
    const weekTitle = weekObj ? `${weekObj.week}주차` : '로딩중...';

    document.getElementById('current-header-title').textContent = `${meta.label} 생산계획서 (${weekTitle})`;
    document.getElementById('btn-switch-line').textContent = `${nextMeta.label} 전환`;

    if (!dbData) {
      this.viewport.innerHTML = `<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#475569;font-weight:700;">데이터를 불러오는 중입니다...</div>`;
      return;
    }

    this.days = this.getDaysFromDB(lineKey);
    this.renderSlides();

    if (keepDayIdx !== null) {
      this.currentDayIdx = keepDayIdx;
    } else {
      const dayNum = new Date().getDay();
      this.currentDayIdx = dayNum === 0 ? 7 : dayNum;
    }

    this.moveTo(this.currentDayIdx, false);
    this.initEvents();
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
          <td><strong>${r.seq ?? '-'}</strong></td>
          <td style="text-align:left; padding-left:16px;">
            <strong>${r.name || '-'}</strong>
            ${r.note ? `<div style="font-size:0.8em; color:#64748b; margin-top:4px; font-weight:500;">※ ${r.note}</div>` : ''}
          </td>
          <td><strong>${r.qty || '-'}</strong></td>
          <td>
            <span class="process-badge ${!r.process || r.process === '-' ? 'process-empty' : ''}">
              ${r.process || '-'}
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
        this.isAnimating = false;
      }, this.ANIM_TIME);
      return;
    }

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
      if (e.key === 'ArrowRight') this.step(1);
      if (e.key === 'ArrowLeft') this.step(-1);
    });

    this.addListener(window, 'resize', () => {
      this.moveTo(this.currentDayIdx, false);
    });
  }
}

/* =========================================
4. 익명 인증 기반 사원 로그인 / 가입 신청 / 승인 감시 컨트롤러
   ========================================= */
const planRenderer = new InfinitePlanRenderer('plan-viewport');

const tabLogin = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const pendingBox = document.getElementById('pending-box');
const authTabsWrap = document.querySelector('.auth-tabs');

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
    isPendingApproval = false;
    btnLogoutSelect.style.display = 'none';
    stopPlanDatabaseListener();
    return;
  }

  await authReady;
  btnLogoutSelect.style.display = 'block';

  unsubscribeEmpWatch = onValue(ref(db, `employees/${empId}`), (snap) => {
    const emp = snap.val();

    // 관리자가 계정을 삭제한 경우 즉시 로그아웃
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
      startPlanDatabaseListener();

      if (pendingLine !== null) {
        const target = pendingLine;
        pendingLine = null;
        openLine(target);
      }
    } else {
      isAuthorized = false;
      isPendingApproval = true;
      pendingUserDisplay = `${emp.name} (${emp.dept})`;
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
  isPendingApproval = false;
  pendingUserDisplay = '';
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

// 앱 시작 시 기존 로그인 세션 자동 복원
const savedEmpId = localStorage.getItem(STORAGE_EMP_KEY);
if (savedEmpId) {
  watchEmployeeSession(savedEmpId);
}

tabLogin.addEventListener('click', () => showAuthTab('login'));
tabSignup.addEventListener('click', () => showAuthTab('signup'));

// 1. 로그인 제출
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

// 2. 계정 신청(가입) 제출
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
  selectedWeekIdx = Number(e.target.value);
  planRenderer.loadLine(planRenderer.currentLine, planRenderer.currentDayIdx);
});

/* =========================================
5. PWA 설치 프롬프트 처리
   ========================================= */
let deferredPrompt;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (deferredPrompt) installBtn.style.display = 'block';
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt = null;
  installBtn.style.display = 'none';
});