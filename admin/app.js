import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase, ref, get, set, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

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
  console.error("관리자 익명 인증 실패:", err);
});

const ADMIN_SESSION_KEY = 'idc_admin_logged_in';
const DEFAULT_ADMIN_PW = 'idcadmin';

const loginScreen = document.getElementById('admin-login-screen');
const dashboardScreen = document.getElementById('admin-dashboard');
const loginError = document.getElementById('admin-login-error');

function sanitizeId(rawId) {
  return rawId.trim().replace(/[.#$\[\]\/]/g, '_');
}

async function showDashboard() {
  await authReady;
  loginScreen.style.display = 'none';
  dashboardScreen.style.display = 'block';
  watchEmployees();
}

if (sessionStorage.getItem(ADMIN_SESSION_KEY) === 'true') {
  showDashboard();
}

// 관리자 로그인
document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inputPw = document.getElementById('admin-password').value.trim();
  loginError.textContent = '';

  try {
    await authReady;
    const snap = await get(ref(db, 'config/adminPassword'));
    const serverAdminPw = snap.val() ? String(snap.val()) : DEFAULT_ADMIN_PW;

    if (inputPw === serverAdminPw) {
      sessionStorage.setItem(ADMIN_SESSION_KEY, 'true');
      showDashboard();
    } else {
      loginError.textContent = '관리자 비밀번호가 일치하지 않습니다.';
    }
  } catch (err) {
    loginError.textContent = 'DB 연결 오류: ' + err.message;
  }
});

// 관리자 로그아웃
document.getElementById('btn-admin-logout').addEventListener('click', () => {
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  window.location.reload();
});

// 관리자 직접 사원 등록
document.getElementById('create-emp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const empId = sanitizeId(document.getElementById('emp-id').value);
  const name = document.getElementById('emp-name').value.trim();
  const dept = document.getElementById('emp-dept').value;
  const password = document.getElementById('emp-password').value.trim();
  const msgEl = document.getElementById('create-msg');

  if (!empId) return;

  try {
    await authReady;
    const existingSnap = await get(ref(db, `employees/${empId}`));
    if (existingSnap.exists()) {
      msgEl.style.color = '#dc2626';
      msgEl.textContent = `이미 등록된 사번(${empId})입니다.`;
      return;
    }

    await set(ref(db, `employees/${empId}`), {
      name,
      dept,
      password,
      active: false, // 보안 규칙상 신규 생성은 false로 시작 후 즉시 true로 승인
      createdAt: new Date().toISOString().slice(0, 10)
    });
    await update(ref(db, `employees/${empId}`), { active: true });

    msgEl.style.color = '#16a34a';
    msgEl.textContent = `✅ [${empId}] ${name} 계정이 등록 및 승인되었습니다.`;
    e.target.reset();
  } catch (err) {
    msgEl.style.color = '#dc2626';
    msgEl.textContent = '등록 실패: ' + err.message;
  }
});

// 사원 목록 실시간 관리 (승인/차단, 비밀번호 변경, 완전 삭제)
function watchEmployees() {
  const tbody = document.getElementById('emp-table-body');
  onValue(ref(db, 'employees'), (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">등록된 사원이 없습니다.</td></tr>';
      return;
    }

    const sorted = Object.entries(data).sort((a, b) => Number(a[1].active) - Number(b[1].active));

    tbody.innerHTML = sorted.map(([empId, emp]) => `
      <tr style="${!emp.active ? 'background:#fffbeb;' : ''}">
        <td><strong>${empId}</strong></td>
        <td>${emp.name || '-'}</td>
        <td>${emp.dept || '-'}</td>
        <td><code style="background:#f1f5f9; padding:3px 6px; border-radius:4px;">${emp.password || '-'}</code></td>
        <td>
          <span class="${emp.active ? 'status-active' : 'status-blocked'}">
            ${emp.active ? '승인 완료' : '승인 대기'}
          </span>
        </td>
        <td>
          <button type="button" class="btn-sm btn-toggle" data-id="${empId}" data-active="${emp.active}"
            style="${!emp.active ? 'background:#2563eb; color:#fff;' : 'background:#e2e8f0; color:#1e293b;'}">
            ${emp.active ? '차단' : '✅ 승인하기'}
          </button>
          <button type="button" class="btn-sm btn-pw" data-id="${empId}" data-name="${emp.name}"
            style="background:#f1f5f9; color:#334155; border:1px solid #cbd5e1;">
            비번변경
          </button>
          <button type="button" class="btn-sm btn-del" data-id="${empId}" data-name="${emp.name}"
            style="background:#fee2e2; color:#dc2626;">
            완전삭제
          </button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const active = btn.dataset.active === 'true';
        await update(ref(db, `employees/${id}`), { active: !active });
      });
    });

    tbody.querySelectorAll('.btn-pw').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const name = btn.dataset.name;
        const newPw = prompt(`'${name} (${id})' 사원의 새 비밀번호를 입력하세요:`);
        if (newPw && newPw.trim()) {
          await update(ref(db, `employees/${id}`), { password: newPw.trim() });
          alert('비밀번호가 변경되었습니다.');
        }
      });
    });

    tbody.querySelectorAll('.btn-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const name = btn.dataset.name;
        if (confirm(`'${name} (${id})' 계정을 완전히 삭제하시겠습니까?\n삭제 후에는 동일한 사번으로 재가입도 가능합니다.`)) {
          await remove(ref(db, `employees/${id}`));
        }
      });
    });
  });
}