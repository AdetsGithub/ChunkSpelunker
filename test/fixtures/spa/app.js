fetch('/api/v1/items', { method: 'GET' });
fetch('/api/v1/users/' + 42 + '/profile');
async function loadReports() {
  history.pushState({}, '', '/reports');
  const s = document.createElement('script');
  s.src = '/chunk-reports.js';
  document.body.appendChild(s);
}
document.getElementById('go-reports').onclick = loadReports;
document.getElementById('logout').onclick = () => { location.href = '/login'; };
//# sourceMappingURL=app.js.map
