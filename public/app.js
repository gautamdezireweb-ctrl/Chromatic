const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const state = { token: localStorage.getItem('arena_token') || '', user: null, page: 'overview', selected: null, round: null, timerHandle: null, dashboard: null };
const money = n => Number(n || 0).toLocaleString('en-IN');
const date = v => { try { return new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z')).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch { return v || '—'; } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let toastTimer;
function toast(message, error=false){ const el=$('#toast'); el.textContent=message; el.classList.toggle('error',error); el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),3800); }
async function api(url, options={}){
  const headers = {...(options.headers||{})};
  if(state.token) headers.Authorization = `Bearer ${state.token}`;
  let body=options.body;
  if(body && !(body instanceof FormData) && typeof body !== 'string'){ headers['Content-Type']='application/json'; body=JSON.stringify(body); }
  const response=await fetch(url,{...options,headers,body});
  let data={}; try{data=await response.json();}catch{}
  if(response.status===401 && state.token){logout(false);}
  if(!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function showAuth(mode='login'){
  $('#authView').classList.remove('hidden'); $('#appView').classList.add('hidden');
  $$('.auth-tab').forEach(b=>b.classList.toggle('active',b.dataset.auth===mode));
  $('#loginForm').classList.toggle('hidden',mode!=='login'); $('#signupForm').classList.toggle('hidden',mode!=='signup');
}
function showApp(){ $('#authView').classList.add('hidden'); $('#appView').classList.remove('hidden'); }
function setPage(page){
  if(page==='admin' && !state.user?.isAdmin){toast('Admin access is restricted.',true);return;}
  state.page=page; $$('.page').forEach(p=>p.classList.toggle('active',p.id===`page-${page}`));
  $$('.nav-item[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
  const titles={overview:['Overview','Good to see you.'],play:['Play arena','Make your next move.'],wallet:['Wallet center','Your credits, your control.'],referrals:['Referrals','Good things travel.'],history:['Activity','Every move, accounted for.'],admin:['Admin control room','Keep the arena in order.']};
  $('#breadcrumbPage').textContent=titles[page]?.[0]||'Overview'; $('#pageTitle').textContent=titles[page]?.[1]||'Overview';
  if(page==='overview') loadDashboard(); if(page==='wallet') loadDashboard(); if(page==='referrals') loadReferrals(); if(page==='history') loadHistory(); if(page==='play') loadGame(); if(page==='admin') loadAdmin();
  window.scrollTo({top:0,behavior:'smooth'});
}
function setBalance(n){ $('#topBalance').innerHTML=`${money(n)} <i>CR</i>`; if($('#walletBalance')) $('#walletBalance').innerHTML=`${money(n)} <i>CR</i>`; if($('#metricCredits')) $('#metricCredits').innerHTML=`${money(n)} <small>CR</small>`; }
function renderTable(target, headers, rows, empty='Nothing to show yet.'){
  const el=$(target); if(!el)return;
  if(!rows.length){el.innerHTML=`<div class="empty-state">${esc(empty)}</div>`;return;}
  el.innerHTML=`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function statusBadge(s){return `<span class="status-badge status-${esc(String(s).toLowerCase())}">${esc(s)}</span>`;}
function renderTransactions(items){return items.map(t=>[
  `<strong>${esc(t.note)}</strong><div style="color:#a0a3b2;font-size:9px;margin-top:4px">${esc(t.type.replaceAll('_',' '))}</div>`,
  esc(date(t.createdAt||t.created_at)), `<span class="${Number(t.amount)>=0?'amount-positive':'amount-negative'}">${Number(t.amount)>0?'+':''}${money(t.amount)} CR</span>`, `${money(t.balanceAfter ?? t.balance_after)} CR`
]);}
async function loadDashboard(){
  try{
    const d=await api('/api/dashboard'); state.dashboard=d; state.user=d.user; setBalance(d.user.credits);
    $('#avatarButton').textContent=(d.user.username||'P').slice(0,1).toUpperCase(); $('#metricReferrals').textContent=d.referrals; $('#metricRequests').textContent=d.requests.filter(r=>r.status==='pending').length;
    renderTable('#recentActivity',['DESCRIPTION','DATE','AMOUNT','BALANCE'],renderTransactions(d.transactions.slice(0,5)),'Your activity will appear here.');
    renderTable('#walletRequests',['REQUEST','METHOD','AMOUNT','STATUS','SUBMITTED'],d.requests.map(r=>[esc(r.kind),esc(r.method.toUpperCase()),`₹${money(r.amount)}`,statusBadge(r.status),esc(date(r.createdAt))]),'No wallet requests yet.');
    if(d.user.isAdmin){if(!$('#adminNav')){$('#mainNav').insertAdjacentHTML('beforeend','<button class="nav-item" id="adminNav" data-page="admin"><span>⌘</span> Admin panel</button>');bindPageButtons();}}
  }catch(e){toast(e.message,true);}
}
async function loadReferrals(){try{const d=await api('/api/referrals');$('#refCode').textContent=d.code;$('#referralCount').textContent=d.count;$('#referralReward').innerHTML=`${money(d.reward)} <small>CR</small>`;$('#signupReward').innerHTML=`${money(d.signupCredits)} <small>CR</small>`;renderTable('#referralList',['PLAYER','JOINED','STATUS'],d.users.map(u=>[esc(u.username),esc(date(u.joinedAt)),statusBadge('Joined')]),'Share your code to see referrals here.');}catch(e){toast(e.message,true);}}
async function loadHistory(){try{const [t,g]=await Promise.all([api('/api/wallet/transactions'),api('/api/game')]);renderTable('#allActivity',['DESCRIPTION','DATE','AMOUNT','BALANCE'],renderTransactions(t.transactions),'No transactions yet.');renderGameHistory('#allGameHistory',g.previous);}catch(e){toast(e.message,true);}}
function renderGameHistory(target,items){renderTable(target,['ROUND','PICK','STAKE','RESULT','PAYOUT','DATE'],items.map(x=>[`#${esc(x.roundId)}`,`${esc(x.pickType)}: <strong>${esc(x.pickValue)}</strong>`,` ${money(x.stake)} CR`,statusBadge(x.result),`${money(x.payout||0)} CR`,esc(date(x.createdAt))]),'No picks yet.');if(target==='#gameHistoryMini'){$(target).innerHTML=items.length?items.slice(0,4).map(x=>`<div class="mini-history-row"><div><strong>${esc(x.pickType)} · ${esc(x.pickValue)}</strong><small>Round #${esc(x.roundId)}</small></div><div style="text-align:right">${statusBadge(x.result)}<small>${money(x.payout||0)} CR</small></div></div>`).join(''):'<div class="empty-state">No picks yet.</div>';}}
async function loadGame(){try{const d=await api('/api/game');state.round=d.round;$('#roundId').textContent=d.round.id;renderGameHistory('#gameHistoryMini',d.previous);updateTimer();if(state.timerHandle)clearInterval(state.timerHandle);state.timerHandle=setInterval(updateTimer,500); }catch(e){toast(e.message,true);}}
function updateTimer(){if(!state.round)return;const sec=Math.max(0,Math.ceil((state.round.closesAt-Date.now())/1000));$('#timer').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;if(sec===0){setTimeout(()=>loadGame(),900);}}
async function loadAdmin(){try{const [s,r,u,a]=await Promise.all([api('/api/admin/summary'),api('/api/admin/requests?status='+encodeURIComponent($('#adminStatusFilter')?.value||'pending')),api('/api/admin/users'),api('/api/admin/audit')]);$('#adminUsers').textContent=money(s.users);$('#adminPending').textContent=money(s.pending);$('#adminDeposits').textContent=money(s.deposits);$('#adminCredits').textContent=money(s.credits);renderAdminRequests(r.requests);renderTable('#adminUsersList',['PLAYER','EMAIL','PHONE','CREDITS','JOINED','ADJUST'],u.users.filter(x=>!x.isAdmin).map(x=>[esc(x.username),esc(x.email),esc(x.phone),`${money(x.credits)} CR`,esc(date(x.createdAt)),`<button class="small-btn proof-btn" data-credit-user="${x.id}">Adjust credits</button>`]),'No player accounts yet.');renderTable('#adminAudit',['EVENT','ACTOR','DETAIL','DATE'],a.logs.map(x=>[esc(x.action),esc(x.username||'System'),esc(x.detail),esc(date(x.createdAt))]),'No audit events yet.');}catch(e){toast(e.message,true);}}
function renderAdminRequests(items){const el=$('#adminRequests');if(!items.length){el.innerHTML='<div class="table-card empty-state">No requests in this view.</div>';return;}el.innerHTML=items.map(r=>`<article class="admin-request-card"><div class="request-main"><div class="request-title"><strong>#${r.id} · ${esc(r.username)}</strong>${statusBadge(r.status)}<span class="tag ${r.kind==='deposit'?'tag-blue':'tag-violet'}">${esc(r.kind.toUpperCase())}</span></div><div class="request-meta"><span>${esc(r.email)}</span><span>${esc(r.phone)}</span><span>${esc(r.method.toUpperCase())}</span><span>${esc(date(r.createdAt))}</span></div><div class="request-details"><strong>Amount:</strong> ₹${money(r.amount)} ${r.reference?` · <strong>Reference:</strong> ${esc(r.reference)}`:''}<br><strong>Details:</strong> ${esc(r.details||'No additional details')}${r.adminNote?`<br><strong>Review note:</strong> ${esc(r.adminNote)}`:''}</div></div><div class="request-actions">${r.uploadName?`<button class="small-btn proof-btn" data-proof="${r.id}">View image</button>`:''}${r.status==='pending'?`<button class="small-btn approve-btn" data-review="approve" data-id="${r.id}">Approve</button><button class="small-btn reject-btn" data-review="reject" data-id="${r.id}">Reject</button>`:''}</div></article>`).join('');}
async function doReview(id,decision){let note=prompt(`${decision==='approve'?'Approval':'Rejection'} note (optional):`);if(note===null)return;try{const d=await api(`/api/admin/requests/${id}/review`,{method:'POST',body:{decision,note}});toast(d.message);loadAdmin();}catch(e){toast(e.message,true);}}
async function showProof(id){$('#modalContent').innerHTML=`<h3>Request #${id} · proof image</h3><p class="muted">Sensitive account image — visible only to authorized admins.</p><p>Loading secure image…</p>`;$('#proofModal').classList.remove('hidden');try{const r=await fetch(`/api/admin/proof/${id}`,{headers:{Authorization:`Bearer ${state.token}`}});if(!r.ok)throw new Error('Could not load proof image.');const blob=await r.blob();const url=URL.createObjectURL(blob);$('#modalContent').innerHTML=`<h3>Request #${id} · proof image</h3><p class="muted">Sensitive account image — visible only to authorized admins.</p><img src="${url}" alt="Uploaded account proof">`;}catch(e){$('#modalContent').innerHTML=`<h3>Request #${id}</h3><p class="muted">${esc(e.message)}</p>`;}}
function bindPageButtons(){ $$('[data-page]').forEach(b=>{if(b.dataset.bound)return;b.dataset.bound='1';b.addEventListener('click',()=>setPage(b.dataset.page));}); }
async function logout(notify=true){try{if(state.token)await api('/api/auth/logout',{method:'POST'});}catch{}state.token='';state.user=null;localStorage.removeItem('arena_token');if(state.timerHandle)clearInterval(state.timerHandle);showAuth('login');if(notify)toast('You have signed out.');}
function enterApp(user,token){state.user=user;state.token=token;localStorage.setItem('arena_token',token);showApp();setPage('overview');loadDashboard();}
$$('[data-auth]').forEach(b=>b.addEventListener('click',()=>showAuth(b.dataset.auth)));
$$('[data-toggle="password"]').forEach(b=>b.addEventListener('click',()=>{const i=b.closest('.password-wrap').querySelector('input');i.type=i.type==='password'?'text':'password';b.textContent=i.type==='password'?'Show':'Hide';}));
$('#loginFormEl').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const f=new FormData(e.currentTarget);const d=await api('/api/auth/login',{method:'POST',body:{identifier:f.get('identifier'),password:f.get('password')}});enterApp(d.user,d.token);toast(`Welcome back, ${d.user.username}.`);}catch(err){toast(err.message,true);}finally{b.disabled=false;}});
$('#signupFormEl').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const f=new FormData(e.currentTarget);const d=await api('/api/auth/signup',{method:'POST',body:{username:f.get('username'),phone:f.get('phone'),email:f.get('email'),password:f.get('password'),confirmPassword:f.get('confirmPassword'),referralCode:f.get('referralCode')}});enterApp(d.user,d.token);toast('Account created. Welcome to Chromatic Arena.');}catch(err){toast(err.message,true);}finally{b.disabled=false;}});
$('#logoutBtn').addEventListener('click',()=>logout());
$('#avatarButton').addEventListener('click',()=>toast(state.user?.isAdmin?'Admin account · use the Admin panel in the sidebar.':`Signed in as ${state.user?.username||'player'}.`));
$('#copyRefBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#refCode').textContent);toast('Referral code copied.');}catch{toast(`Your referral code is ${$('#refCode').textContent}`);}});
$$('[data-type]').forEach(b=>b.addEventListener('click',()=>{$$('.color-pick,.number-picks button,.size-picks button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');state.selected={type:b.dataset.type,value:b.dataset.value};}));
$$('[data-stake]').forEach(b=>b.addEventListener('click',()=>$('#stakeInput').value=b.dataset.stake));
$('#placeBetBtn').addEventListener('click',async()=>{if(!state.selected){toast('Choose a color, number, or size first.',true);return;}const stake=Number($('#stakeInput').value);const b=$('#placeBetBtn');b.disabled=true;try{const d=await api('/api/game/bet',{method:'POST',body:{...state.selected,stake}});toast(d.message);setBalance(d.balance);state.selected=null;$$('.selected').forEach(x=>x.classList.remove('selected'));setTimeout(()=>loadGame(),300);}catch(e){toast(e.message,true);}finally{b.disabled=false;}});
$('#withdrawMethod').addEventListener('change',()=>{const bank=$('#withdrawMethod').value==='bank';$('#withdrawDetailsLabel').innerHTML=bank?'Account holder & bank details<textarea name="details" rows="2" required placeholder="Account holder, bank, account number and IFSC"></textarea>':'UPI ID / payout details<textarea name="details" rows="2" required placeholder="yourname@upi"></textarea>';$('#proofHint').textContent=bank?'PASSBOOK IMAGE · REQUIRED':'UPI QR IMAGE · REQUIRED';$('#withdrawHelp').textContent=bank?'For bank transfer, attach a clear passbook image showing account holder and bank details.':'For UPI payout, attach a clear image of your UPI QR code.';});
function bindWalletForm(id,kind){$(id).addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const b=e.submitter;b.disabled=true;const fd=new FormData(form);fd.set('kind',kind);try{const d=await api('/api/wallet/request',{method:'POST',body:fd});toast(d.message);form.reset();if(kind==='withdrawal')$('#withdrawMethod').dispatchEvent(new Event('change'));await loadDashboard();}catch(err){toast(err.message,true);}finally{b.disabled=false;}});}
bindWalletForm('#depositForm','deposit');bindWalletForm('#withdrawForm','withdrawal');
$('#adminStatusFilter').addEventListener('change',loadAdmin);$('#refreshHistory').addEventListener('click',loadHistory);
document.addEventListener('click',e=>{const p=e.target.closest('[data-proof]');if(p)showProof(p.dataset.proof);const r=e.target.closest('[data-review]');if(r)doReview(r.dataset.id,r.dataset.review);const c=e.target.closest('[data-credit-user]');if(c){const amount=prompt('Credit adjustment (positive to add, negative to remove):');if(amount===null)return;const n=Number(amount);if(!Number.isInteger(n)||!n){toast('Enter a non-zero whole number.',true);return;}const note=prompt('Reason for adjustment:','Admin wallet adjustment');if(note===null)return;api(`/api/admin/users/${c.dataset.creditUser}/credits`,{method:'POST',body:{amount:n,note}}).then(()=>{toast('Wallet adjusted.');loadAdmin();}).catch(err=>toast(err.message,true));}if(e.target.matches('[data-close-modal]'))$('#proofModal').classList.add('hidden');});
function loadReferralFromQuery(){const code=new URLSearchParams(location.search).get('ref');if(code){$('#referralInput').value=code.toUpperCase();showAuth('signup');}}
async function init(){bindPageButtons();loadReferralFromQuery();if(!state.token){showAuth('login');return;}try{const d=await api('/api/me');enterApp(d.user,state.token);}catch{showAuth('login');}}
init();
