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
      active: false,
      canEdit: false,
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

// 사원 목록 실시간 관리 (승인/차단, 권한부여, 소속변경, 비밀번호변경, 완전삭제)
function watchEmployees() {
  const tbody = document.getElementById('emp-table-body');
  onValue(ref(db, 'employees'), (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">등록된 사원이 없습니다.</td></tr>';
      return;
    }

    const sorted = Object.entries(data).sort((a, b) => Number(a[1].active) - Number(b[1].active));

    tbody.innerHTML = sorted.map(([empId, emp]) => {
      const canEdit = emp.canEdit === true;
      return `
        <tr class="emp-card-row" style="${!emp.active ? 'background:#fffbeb;' : ''}">
          <td><strong>${empId}</strong></td>
          <td>${emp.name || '-'}</td>
          <td>${emp.dept || '-'}</td>
          <td><code style="background:#f1f5f9; padding:3px 6px; border-radius:4px;">${emp.password || '-'}</code></td>
          <td>
            <span class="${emp.active ? 'status-active' : 'status-blocked'}">
              ${emp.active ? '승인 완료' : '승인 대기'}
            </span>
            ${canEdit ? '<span class="status-admin" style="margin-left:4px;">관리자권한</span>' : ''}
          </td>
          <td>
            <button type="button" class="btn-sm btn-toggle" data-id="${empId}" data-active="${emp.active}"
              style="${!emp.active ? 'background:#2563eb; color:#fff;' : 'background:#e2e8f0; color:#1e293b;'}">
              ${emp.active ? '차단' : '✅ 승인하기'}
            </button>
            <button type="button" class="btn-sm btn-edit-toggle" data-id="${empId}" data-canedit="${canEdit}"
              style="${canEdit ? 'background:#d97706; color:#fff;' : 'background:#f1f5f9; color:#334155; border:1px solid #cbd5e1;'}">
              ${canEdit ? '권한회수' : '관리자권한부여'}
            </button>
            <button type="button" class="btn-sm btn-dept-change" data-id="${empId}" data-name="${emp.name}" data-dept="${emp.dept || ''}"
              style="background:#0f766e; color:#fff;">
              소속변경
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
      `;
    }).join('');

    // 승인/차단 토글 이벤트
    tbody.querySelectorAll('.btn-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const active = btn.dataset.active === 'true';
        await update(ref(db, `employees/${id}`), { active: !active });
      });
    });

    // 관리자 권한(canEdit) 토글 이벤트
    tbody.querySelectorAll('.btn-edit-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const canEdit = btn.dataset.canedit === 'true';
        await update(ref(db, `employees/${id}`), { canEdit: !canEdit });
      });
    });

    // 소속 변경 이벤트
    tbody.querySelectorAll('.btn-dept-change').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const name = btn.dataset.name;
        const currentDept = btn.dataset.dept;
        const newDept = prompt(`'${name} (${id})' 사원의 새 소속을 입력하세요\n(선택 가능: 임프린팅, 1호기, 2호기, 공통/관리, 손님):`, currentDept);
        if (newDept !== null) {
          const trimmed = newDept.trim();
          const validDepts = ['임프린팅', '1호기', '2호기', '공통/관리', '손님'];
          if (validDepts.includes(trimmed)) {
            await update(ref(db, `employees/${id}`), { dept: trimmed });
            alert('소속이 변경되었습니다.');
          } else {
            alert('올바른 소속 라인 명칭을 입력해 주세요. (임프린팅, 1호기, 2호기, 공통/관리, 손님 중 선택)');
          }
        }
      });
    });

    // 비밀번호 변경 이벤트
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

    // 완전 삭제 이벤트
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