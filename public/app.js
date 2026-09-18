const $=id=>document.getElementById(id); const readJson=async r=>{const text=await r.text();try{return JSON.parse(text)}catch{throw Error(r.ok?"应用返回了无法识别的数据。请重启应用后重试。":`应用发生错误（HTTP ${r.status}）。请查看终端中的详细信息。`)}}; const post=(url,body={})=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(async r=>{const j=await readJson(r);if(!r.ok)throw Error(j.error||"操作失败");return j});
const invoke=window.__TAURI__.core.invoke;
let token=null;
let lastOutputDir=null;
let loggedIn=false;
let busy=false;

let toastTimer=null;
function showToast(message,isError){
  const t=$("toast");
  t.textContent=message;
  t.className="toast"+(isError?" error":"");
  t.hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{t.hidden=true},isError?5000:3000);
}

// Lets the user step away during a long export and still know when it's
// done, without this app playing its own sound — the system notification's
// sound (or lack of one, under Do Not Disturb etc.) already follows
// whatever the user has set for notifications in general. Uses the plain
// Web Notification API directly (no @tauri-apps/plugin-notification
// import): the WKWebView backing this window routes it to the real macOS
// notification center, and this app has no bundler for public/app.js to
// import an npm package into anyway.
async function ensureNotificationPermission(){
  if(window.Notification.permission==="granted") return true;
  if(window.Notification.permission==="denied") return false;
  try{ return (await window.Notification.requestPermission())==="granted"; }catch{ return false; }
}
function notify(title,body){
  if(window.Notification.permission==="granted"){ try{ new window.Notification(title,{body}); }catch{} }
}

// Measures the page's own rendered height rather than using a guessed
// constant, so the window always fits exactly (no scrollbar, no dead
// space) regardless of font-rendering differences between the WKWebView
// used in the packaged app and whatever this was last tuned against.
//
// Uses the last element's actual bottom position rather than
// document.body.scrollHeight: <main>'s margin-top collapses through the
// (border/padding-less) <body>, so scrollHeight silently undercounts it —
// getBoundingClientRect() isn't fooled by margin collapse.
async function resizeToContent(){
  const titlebarAllowance=32;
  const measureContent=()=>{
    const bottoms=[document.querySelector("footer").getBoundingClientRect().bottom];
    for(const card of document.querySelectorAll(".overlay:not([hidden]) .about-card")) bottoms.push(card.getBoundingClientRect().top+card.scrollHeight);
    return Math.max(...bottoms);
  };
  const target=measureContent()+titlebarAllowance;
  await invoke("resize_main_window",{height:target}).catch(()=>{});
  await new Promise(r=>setTimeout(r,150));
  const overflow=document.documentElement.scrollHeight-window.innerHeight;
  if(overflow>0){
    invoke("resize_main_window",{height:target+overflow+8}).catch(()=>{});
  }
}

// Renders the per-item/per-subtask task list (see src/types.ts's ExportTask)
// incrementally rather than rebuilding the DOM every poll: rows are created
// once per item id and then only patched in place, so scrolling through a
// long list — or an expanded detail panel — isn't reset out from under the
// user every 1.2s.
const statusLabel=s=>s==="active"?"进行中":s==="done"?"完成":s==="error"?"失败":s==="skipped"?"已跳过":s==="deleted"?"已删除":"未开始";
const subTaskLabel=key=>key==="images"?"图片":key==="word"?"Word":"写入";
const taskRows=new Map();
function clearTaskList(){
  taskRows.clear();
  $("task-list").replaceChildren();
  $("task-list").hidden=true;
}
function buildTaskRow(t){
  const item=document.createElement("div"); item.className="task-item";
  const row=document.createElement("div"); row.className="task-row";
  const dot=document.createElement("span"); dot.className="task-dot";
  const title=document.createElement("span"); title.className="task-title"; title.textContent=t.title;
  // Read-only hint only — exact-content duplicate candidates are flagged
  // here so the user can see them, but no merge/skip action exists.
  const dup=document.createElement("span"); dup.className="task-dup"; dup.textContent="疑似重复"; dup.hidden=true;
  // Shown once the backend has confirmed (via DeletedContentError) that the
  // article's own author deleted it — a permanent state a later run skips
  // outright (see ExportControl.deletedItemIds), so this badge is the only
  // visible trace of it once that happens, not just an error-dot tooltip.
  const deleted=document.createElement("span"); deleted.className="task-deleted"; deleted.textContent="已删除"; deleted.hidden=true;
  const actions=document.createElement("span"); actions.className="task-actions";
  const skipBtn=document.createElement("button"); skipBtn.type="button"; skipBtn.className="task-skip"; skipBtn.textContent="跳过"; skipBtn.hidden=true;
  skipBtn.onclick=()=>{ skipBtn.disabled=true; post("/api/export/skip",{id:t.id,scope:"item"}).catch(e=>{ skipBtn.disabled=false; showToast(e.message||String(e),true); }); };
  const expandBtn=document.createElement("button"); expandBtn.type="button"; expandBtn.className="task-expand"; expandBtn.textContent="▸"; expandBtn.setAttribute("aria-label","展开详情");
  actions.append(skipBtn,expandBtn);
  row.append(dot,title,dup,deleted,actions);

  const detail=document.createElement("div"); detail.className="task-detail"; detail.hidden=true;
  const subEls=new Map();
  for(const s of t.subtasks){
    const subRow=document.createElement("div"); subRow.className="task-detail-row";
    const subDot=document.createElement("span"); subDot.className="task-dot";
    const subLabelEl=document.createElement("span"); subLabelEl.textContent=subTaskLabel(s.key);
    subRow.append(subDot,subLabelEl);
    const entry={dot:subDot,label:subLabelEl};
    if(s.key==="images"){
      const skipImagesBtn=document.createElement("button"); skipImagesBtn.type="button"; skipImagesBtn.className="task-skip"; skipImagesBtn.textContent="跳过图片"; skipImagesBtn.hidden=true;
      skipImagesBtn.onclick=()=>{ skipImagesBtn.disabled=true; post("/api/export/skip",{id:t.id,scope:"images"}).catch(e=>{ skipImagesBtn.disabled=false; showToast(e.message||String(e),true); }); };
      subRow.appendChild(skipImagesBtn); entry.skipBtn=skipImagesBtn;
      const list=document.createElement("div"); list.className="task-image-list"; detail.appendChild(subRow); detail.appendChild(list); entry.list=list; entry.imageEls=new Map();
    }else{
      detail.appendChild(subRow);
    }
    subEls.set(s.key,entry);
  }
  expandBtn.onclick=()=>{
    const willExpand=detail.hidden;
    detail.hidden=!willExpand; expandBtn.textContent=willExpand?"▾":"▸";
    resizeToContent();
  };
  item.append(row,detail);
  return {item,dot,dup,deleted,skipBtn,subEls};
}
function patchTaskRow(entry,t){
  // Both "skipped" (user chose to skip) and "deleted" (author deleted it)
  // are terminal, nothing-to-do-here states, so they share the same dim +
  // strikethrough treatment — "deleted" additionally gets its own badge
  // below, since unlike a skip it isn't a choice the user just made and
  // would otherwise have no way to tell apart from a plain failure.
  entry.item.classList.toggle("skipped",t.status==="skipped"||t.status==="deleted");
  entry.dot.className="task-dot "+t.status;
  entry.dot.title=statusLabel(t.status)+(t.error?`：${t.error}`:"");
  entry.dup.hidden=!t.duplicate;
  entry.deleted.hidden=t.status!=="deleted";
  if(t.duplicate) entry.dup.title=`与 ${t.duplicate.otherTitles.length} 项内容完全一致：${t.duplicate.otherTitles.join("、")}`;
  entry.skipBtn.hidden=t.status!=="pending";
  for(const s of t.subtasks){
    const sub=entry.subEls.get(s.key); if(!sub) continue;
    sub.dot.className="task-dot "+s.status; sub.dot.title=statusLabel(s.status);
    sub.label.textContent=subTaskLabel(s.key)+(s.key==="images"&&s.images?` (${s.images.length})`:"");
    if(sub.skipBtn) sub.skipBtn.hidden=s.status!=="pending";
    if(s.key!=="images"||!s.images) continue;
    for(const img of s.images){
      let ie=sub.imageEls.get(img.url);
      if(!ie){
        const row=document.createElement("div"); row.className="task-image-row";
        const dot=document.createElement("span"); dot.className="task-dot";
        const label=document.createElement("span"); label.className="task-image-url"; label.textContent=img.url;
        row.append(dot,label); sub.list.appendChild(row);
        ie={dot,label}; sub.imageEls.set(img.url,ie);
      }
      ie.dot.className="task-dot "+img.status; ie.dot.title=statusLabel(img.status)+(img.error?`：${img.error}`:"");
      ie.label.title=img.url+(img.error?`\n${img.error}`:"");
    }
  }
}
function renderTasks(tasks){
  const list=$("task-list");
  const wasHidden=list.hidden;
  if(!tasks||!tasks.length){ if(!wasHidden){ list.hidden=true; resizeToContent(); } return; }
  for(const t of tasks){
    let entry=taskRows.get(t.id);
    if(!entry){ entry=buildTaskRow(t); list.appendChild(entry.item); taskRows.set(t.id,entry); }
    patchTaskRow(entry,t);
  }
  if(wasHidden){ list.hidden=false; resizeToContent(); }
}

function syncControls(){
  const disabled=!loggedIn||busy;
  $("dir").disabled=disabled;
  $("browse").disabled=disabled;
  $("images").disabled=disabled;
  $("export").disabled=disabled;
  $("auth-btn").disabled=busy;
}

function setAuthUI(nextLoggedIn){
  loggedIn=nextLoggedIn;
  const btn=$("auth-btn");
  btn.textContent=loggedIn?"退出登录":"开始登录";
  btn.classList.toggle("secondary",loggedIn);
  $("step-title").textContent=loggedIn?"可以导出":"登录公众号导出";
  // Once logged in this line would just repeat the footer's identical
  // sentence ("所有内容...不会上传到任何地方") — hide it instead of showing
  // the same trust message twice.
  $("auth-status").hidden=loggedIn;
  $("save-location-row").hidden=!loggedIn;
  $("download-actions").hidden=!loggedIn;
  syncControls();
}

// Relays public-account backend fetches requested by the Node backend
// through the login window, since only this (Tauri) side can reach it — see
// do_weixin_fetch in src-tauri/src/lib.rs.
async function relayFrontendFetches(){
  for(;;){
    let next;
    try{ next=await fetch("/api/frontend-fetch-request").then(readJson); }
    catch{ await new Promise(r=>setTimeout(r,2000)); continue; }
    if(!next) continue;
    let status=0,body="";
    try{ [status,body]=await invoke("weixin_fetch",{url:next.url}); }
    catch(e){ status=0; body=String(e); }
    await post("/api/frontend-fetch-result",{id:next.id,status,body}).catch(()=>{});
  }
}

// On launch: silently check whether a previous run's login window session
// is still holding a valid token (see check_login_status in
// src-tauri/src/lib.rs), so the user only sees the auth step when they
// actually need it.
(async()=>{
  relayFrontendFetches();
  try{
    const r=await invoke("check_login_status");
    if(r.loggedIn){
      token=r.token;
      $("dir").value="exports";
      $("status-section").hidden=false;
      setAuthUI(true);
      resizeToContent();
      return;
    }
  }catch{}
  setAuthUI(false);
  resizeToContent();
})();

$("auth-btn").onclick=async()=>{
  if(loggedIn){
    $("auth-btn").disabled=true;
    try{ await invoke("logout"); }catch(e){ showToast(e.message||String(e),true); }
    await post("/api/reset").catch(()=>{});
    token=null;
    lastOutputDir=null;
    completedAtDir=null;
    $("dir").value="exports";
    $("status-section").hidden=true;
    clearTaskList();
    setAuthUI(false);
    resizeToContent();
    showToast("已退出登录");
    return;
  }
  $("auth-btn").disabled=true;
  try{
    await invoke("open_login_window");
    const result=await invoke("wait_for_login");
    // Auto-dismiss the login window the moment login succeeds — it's a
    // large window (1000x760) sitting on top of the much smaller main
    // window, so without this the user has to notice and manually minimize
    // it before they can see the just-unlocked download step underneath.
    invoke("close_login_window").catch(()=>{});
    token=result.token;
    $("dir").value="exports";
    $("status-section").hidden=false;
    setAuthUI(true);
    resizeToContent();
  }catch(e){
    showToast(e.message||String(e),true);
    $("auth-btn").disabled=false;
  }
};
function openAbout(){
  $("about-overlay").hidden=false;
  fetch("/api/about").then(readJson).then(({version})=>{
    $("about-version").textContent=version;
    resizeToContent();
  }).catch(()=>{});
}
function closeAbout(){ $("about-overlay").hidden=true; resizeToContent(); }
$("about-btn").onclick=openAbout;
$("about-close").onclick=closeAbout;
$("about-overlay").onclick=(e)=>{ if(e.target.id==="about-overlay") closeAbout(); };
document.addEventListener("keydown",(e)=>{ if(e.key==="Escape"&&!$("about-overlay").hidden) closeAbout(); });
$("about-repo").onclick=()=>{
  invoke("plugin:opener|open_url",{url:"https://github.com/zhangyingfeng/wei-dang"}).catch(e=>showToast(e.message||String(e),true));
};
$("browse").onclick=async()=>{
  try{
    const selected=await invoke("plugin:dialog|open",{options:{directory:true,multiple:false,title:"选择保存位置"}});
    if(selected) $("dir").value=selected;
  }catch(e){ showToast(e.message||String(e),true); }
};
// A single button that swaps roles instead of two side-by-side buttons: once
// an export finishes, "开始导出" turns into "在访达中显示" (same button, new
// label and click behavior) rather than disabling one and revealing another
// next to it. It swaps back the moment "保存位置" changes to anything other
// than the directory that just finished — see the mode toggle in the
// polling loop below.
$("word-reveal-btn").onclick=()=>{
  if(lastOutputDir) invoke("plugin:opener|reveal_item_in_dir",{paths:[`${lastOutputDir}/word`]}).catch(e=>showToast(e.message||String(e),true));
};
$("export").onclick=async()=>{
  if($("export").dataset.mode==="reveal"){
    if(lastOutputDir) invoke("plugin:opener|reveal_item_in_dir",{paths:[lastOutputDir]}).catch(e=>showToast(e.message||String(e),true));
    return;
  }
  if(!token){
    try{ token=(await invoke("check_login_status")).token; }catch{}
  }
  if(!token){
    showToast("登录状态已丢失，请重新登录。",true);
    $("status-section").hidden=true;
    setAuthUI(false);
    resizeToContent();
    return;
  }
  completedAtDir=null;
  clearTaskList();
  ensureNotificationPermission();
  post("/api/export",{outputDir:$("dir").value,downloadImages:$("images").checked,delayMs:1200,token}).catch(e=>showToast(e.message,true));
};
$("pause-btn").onclick=()=>{
  const btn=$("pause-btn"); const willPause=btn.textContent==="暂停";
  btn.disabled=true;
  post(willPause?"/api/export/pause":"/api/export/resume").catch(e=>showToast(e.message||String(e),true)).finally(()=>{ btn.disabled=false; });
};
let lastPhase=null;
// The directory that was current at the moment an export finished. While
// "保存位置" still holds that exact value, the button stays in "在访达中
// 显示" mode; the moment it no longer matches (typed, or picked via
// "浏览…"), the button swaps back to "开始导出" for a fresh run. Comparing
// values on every tick, rather than listening for input events, means it
// doesn't matter *how* the field changed.
let completedAtDir=null;
setInterval(async()=>{try{
  const {progress:p}=await fetch("/api/status").then(readJson);
  // The backend's progress/tasks belong to whatever export last ran and
  // aren't reset on logout (logout is a Tauri-side session clear, not an
  // HTTP call) — without this guard, the very next tick would flip the
  // button back to "在访达中显示" and repopulate the task list right after
  // clearTaskList() clears them, since the stale data is still sitting in
  // /api/status.
  if(!loggedIn) return;
  $("message").textContent=p.message;
  $("count").textContent=p.total?`${p.current||0} / ${p.total}`:(p.current?String(p.current):"");
  $("bar").value=p.total?100*(p.current||0)/p.total:0;
  // "session-expired" (see src/types.ts's Progress.phase) means the run
  // stopped early — login state stopped working, not every item finished —
  // but there's still a real, partial, resumable archive at p.outputDir, so
  // it's rendered the same as "done" rather than as an error.
  const finished=p.phase==="done"||p.phase==="session-expired";
  $("dot").className=p.phase==="error"?"error":finished?"done":p.phase==="idle"?"idle":"active";
  renderTasks(p.tasks);
  const nextBusy=p.phase==="listing"||p.phase==="exporting";
  if(nextBusy!==busy){ busy=nextBusy; syncControls(); }
  if(finished&&p.outputDir){
    lastOutputDir=p.outputDir;
    if(lastPhase!==p.phase){
      showToast(p.phase==="session-expired"?p.message:`导出完成：${p.outputDir}`);
      notify("微档",p.message||`导出完成：${p.outputDir}`);
      // The session-expired stop is easy to miss if it's only a toast
      // (auto-dismisses in 3-5s) or a system notification (silent if the OS
      // one is muted, or the app isn't focused) — whether it happened
      // before a single item was exported or 26 items in, the user needs to
      // actually see why the run stopped short, not just infer it from a
      // static message line. A native modal blocks until acknowledged.
      if(p.phase==="session-expired") invoke("plugin:dialog|message",{message:p.message,title:"微档 · 登录状态已失效",kind:"warning"}).catch(()=>{});
      completedAtDir=$("dir").value;
    }
  }
  const justCompleted=finished&&completedAtDir!==null&&$("dir").value===completedAtDir;
  $("export").dataset.mode=justCompleted?"reveal":"export";
  $("export").textContent=justCompleted?"在访达中显示":busy?"导出中…":"开始导出";
  $("export").disabled=justCompleted?false:(busy||!loggedIn);
  // Only ever meaningful once this run's outputDir is known and finished —
  // same gate as the main button's reveal mode, so it appears/disappears
  // in lockstep with it rather than needing its own tracking.
  $("word-reveal-btn").hidden=!justCompleted;
  // Pausing only makes sense once there's an actual export loop running
  // (listing itself can't be paused — it's a couple of quick paginated
  // fetches, not the long per-item work pause targets).
  $("pause-btn").hidden=p.phase!=="exporting";
  $("pause-btn").textContent=p.paused?"继续":"暂停";
  lastPhase=p.phase;
}catch{}},1200);
