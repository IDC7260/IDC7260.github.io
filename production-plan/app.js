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
2. 라인 정보 및 주간 통합생산계획서 데이터
   ========================================= */
const LINE_META = {
  imprinting: { label: '임프린팅', next: 1 },
  1: { label: '1호기', next: 2 },
  2: { label: '2호기', next: 'imprinting' }
};

const SAMPLE_WEEK_DATA = {
  imprinting: [
    { dayLabel: '월요일 (11/09)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '화요일 (11/10)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '수요일 (11/11)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '목요일 (11/12)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '금요일 (11/13)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '토요일 (11/14)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '일요일 (11/15)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]}
  ],
  1: [
    { dayLabel: '월요일 (11/09)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '화요일 (11/10)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '수요일 (11/11)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '목요일 (11/12)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '금요일 (11/13)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '토요일 (11/14)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '일요일 (11/15)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]}
  ],
  2: [
    { dayLabel: '월요일 (11/09)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '화요일 (11/10)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '수요일 (11/11)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '목요일 (11/12)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '금요일 (11/13)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '토요일 (11/14)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]},
    { dayLabel: '일요일 (11/15)', imageUrl: '', rows: [
      { seq: '-', name: '등록된 생산 계획 없음', qty: '-', process: '-' }
    ]}
  ]
};

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

  loadLine(lineKey, keepDayIdx = null) {
    this.destroy();
    this.currentLine = lineKey;
    this.days = SAMPLE_WEEK_DATA[lineKey] || [];

    const meta = LINE_META[lineKey];
    const nextMeta = LINE_META[meta.next];

    document.getElementById('current-header-title').textContent = `${meta.label} 생산계획서 (2026년 11월 2주차)`;
    document.getElementById('btn-switch-line').textContent = `${nextMeta.label} 전환`;

    this.renderSlides();

    if (keepDayIdx !== null) {
      this.currentDayIdx = keepDayIdx;
    } else {
      // 오늘 요일 자동 선택 (월=1 ... 일=7)
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
      const rowsHtml = dayData.rows.map((r) => `
        <tr>
          <td><strong>${r.seq}</strong></td>
          <td style="text-align:left; padding-left:16px;"><strong>${r.name}</strong></td>
          <td><strong>${r.qty}</strong></td>
          <td>
            <span class="process-badge ${r.process === '-' ? 'process-empty' : ''}">
              ${r.process}
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

    // 무한 루프를 위해 맨 앞에 마지막 날 클론, 맨 뒤에 첫째 날 클론 배치
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
4. 화면 전환 및 초기화 컨트롤러
   ========================================= */
const planRenderer = new InfinitePlanRenderer('plan-viewport');
const selectScreen = document.getElementById('select-screen');
const planScreen = document.getElementById('plan-screen');

function openLine(lineKey, keepDayIdx = null) {
  selectScreen.style.display = 'none';
  planScreen.style.display = 'flex';
  planRenderer.loadLine(lineKey, keepDayIdx);
}

function backToSelect() {
  planRenderer.destroy();
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