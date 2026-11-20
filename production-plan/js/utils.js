export const LINE_META = {
  imprinting: { label: '임프린팅' },
  1: { label: '1호기' },
  2: { label: '2호기' }
};

export const DAY_NAMES_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
export const STORAGE_EMP_KEY = 'idc_logged_in_emp_id';

export function sanitizeId(rawId) {
  return rawId.trim().replace(/[.#$\[\]\/]/g, '_');
}

export function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;');
}

export function parseLocalDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatDateYMD(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getMondayOfDate(dateObj) {
  const diffToMon = (dateObj.getDay() + 6) % 7;
  return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate() - diffToMon);
}

export function getSortedWeekKeys(weeksObj) {
  if (!weeksObj || typeof weeksObj !== 'object') return [];
  return Object.keys(weeksObj)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && weeksObj[k])
    .sort();
}

export function findCurrentWeekKey(weeksObj) {
  const keys = getSortedWeekKeys(weeksObj);
  if (keys.length === 0) return '';

  const thisMondayKey = formatDateYMD(getMondayOfDate(new Date()));
  if (keys.includes(thisMondayKey)) return thisMondayKey;

  return keys[keys.length - 1];
}

export function getWeekTemplateKey(weekKey) {
  return `week_${weekKey}`.replace(/[.#$\[\]\/\s~()]/g, '_');
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}