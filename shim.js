/* Firebase bridge: gives the ledger the same db / assets / downloads API it had on Claude */
(function(){
  const cfg=window.FIREBASE_CONFIG||{};
  const ALLOWED=(window.ALLOWED_EMAIL||'').toLowerCase();
  let ready,readyP=new Promise(r=>ready=r);
  const api={};
  window.claude={use:async n=>{await readyP;return api[n]||null;}};
  const $=id=>document.getElementById(id);
  function gate(show,msg){const g=$('fbGate');if(!g)return;g.hidden=!show;if(msg!==undefined)$('fbGateMsg').textContent=msg;}
  if(!cfg.apiKey){document.addEventListener('DOMContentLoaded',()=>{gate(true,'This app is not connected to Firebase yet. Add the Firebase settings to config.js.');$('fbForm').hidden=true;});return;}
  firebase.initializeApp(cfg);
  const fs=firebase.firestore(),auth=firebase.auth();
  try{fs.enablePersistence({synchronizeTabs:true}).catch(()=>{});}catch(e){}
  const wrap=ds=>({id:ds.id,exists:ds.exists,data:()=>ds.data()});
  api.db={
    collection:c=>({onSnapshot:(f,e)=>fs.collection(c).onSnapshot(q=>f({docs:q.docs.map(wrap)}),e),
      get:async()=>({docs:(await fs.collection(c).get()).docs.map(wrap)})}),
    doc:p=>{const r=fs.doc(p);return{set:d=>r.set(d),update:d=>r.update(d),delete:()=>r.delete(),
      get:async()=>wrap(await r.get()),onSnapshot:(f,e)=>r.onSnapshot(ds=>f(wrap(ds)),e)};}
  };
  const MAX=880000; // stay under Firestore's 1 MB document limit
  const readURL=b=>new Promise((ok,no)=>{const fr=new FileReader();fr.onload=()=>ok(fr.result);fr.onerror=no;fr.readAsDataURL(b);});
  async function shrink(dataUrl){
    const img=await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=dataUrl;});
    let w=img.naturalWidth,h=img.naturalHeight,s=Math.min(1,1600/Math.max(w,h));
    for(let q=.8,k=0;k<8;k++){
      const c=document.createElement('canvas');c.width=Math.round(w*s);c.height=Math.round(h*s);
      const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);
      const out=c.toDataURL('image/jpeg',q);if(out.length<=MAX)return out;
      if(q>.55)q-=.1;else s*=.8;
    }
    throw {code:'too_large'};
  }
  async function toStored(dataUrl,type){
    if(/^image\//.test(type)&&(dataUrl.length>MAX||type!=='image/jpeg'))return {data:await shrink(dataUrl),type:'image/jpeg'};
    if(dataUrl.length>MAX)throw {code:'too_large'};
    return {data:dataUrl,type};
  }
  const rid=()=>{const a=new Uint8Array(16);crypto.getRandomValues(a);return [...a].map(b=>b.toString(16).padStart(2,'0')).join('');};
  const cache={};
  api.assets={
    upload:async(file,opt)=>{const type=(opt&&opt.type)||file.type||'image/jpeg';
      if(!/^image\//.test(type)&&type!=='application/pdf')throw {code:'unsupported_type'};
      const st=await toStored(await readURL(file),type);const id=rid();
      await fs.doc('receipts/'+id).set({type:st.type,data:st.data,createdAt:Date.now()});cache[id]=st;
      return {id,url:st.data,contentType:st.type,sizeBytes:st.data.length};}
  };
  api.downloads={save:async({filename,data})=>{
    const blob=data instanceof Blob?data:new Blob([data]);const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();
    setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},5000);return {status:'saved'};}};
  window.fb={
    receipt:async id=>{if(cache[id])return cache[id];const d=await fs.doc('receipts/'+id).get();if(!d.exists)return null;return cache[id]=d.data();},
    signOut:()=>auth.signOut().then(()=>location.reload()),
    user:()=>auth.currentUser,
    async importBackup(obj,progress){
      if(!obj||obj.app!=='house-build-ledger')throw new Error('This is not a ledger backup file.');
      const small=[];
      if(obj.settings)small.push(['settings/main',obj.settings]);
      for(const [c,arr] of [['suppliers',obj.suppliers],['bills',obj.bills],['payments',obj.payments]])
        for(const x of arr||[]){const {id,...rest}=x;if(id)small.push([c+'/'+id,rest]);}
      for(let i=0;i<small.length;i+=400){const b=fs.batch();small.slice(i,i+400).forEach(([p,d])=>b.set(fs.doc(p),d));await b.commit();progress&&progress(`Saved ${Math.min(i+400,small.length)} of ${small.length} records`);}
      const R=Object.entries(obj.receipts||{});let n=0,bad=0;
      for(const [id,r] of R){n++;progress&&progress(`Saving receipt photos ${n} of ${R.length}`);
        try{const st=await toStored(r.data,r.type||'image/jpeg');await fs.doc('receipts/'+id).set({type:st.type,data:st.data,createdAt:Date.now()});}catch(e){bad++;}}
      return {records:small.length,receipts:R.length-bad,failed:bad};
    },
    async exportBackup(progress){
      const get=async c=>(await fs.collection(c).get()).docs.map(d=>({id:d.id,...d.data()}));
      const out={app:'house-build-ledger',version:1,exportedAt:new Date().toISOString()};
      const s=await fs.doc('settings/main').get();out.settings=s.exists?s.data():null;
      out.suppliers=await get('suppliers');out.bills=await get('bills');out.payments=await get('payments');
      progress&&progress('Reading receipt photos…');out.receipts={};
      (await fs.collection('receipts').get()).docs.forEach(d=>{const r=d.data();out.receipts[d.id]={type:r.type,data:r.data};});
      return out;
    }
  };
  document.addEventListener('DOMContentLoaded',()=>{
    $('fbForm').addEventListener('submit',async e=>{e.preventDefault();const b=$('fbBtn');b.disabled=true;$('fbGateMsg').textContent='';
      try{await auth.signInWithEmailAndPassword($('fbEmail').value.trim(),$('fbPass').value);}
      catch(err){$('fbGateMsg').textContent=/wrong-password|invalid-credential|user-not-found|invalid-login/.test(err.code||'')?'Email or password is wrong.':(err.code==='auth/network-request-failed'?'No internet. Check your connection and try again.':'Sign-in failed: '+(err.message||err.code));}
      finally{b.disabled=false;}});
    $('fbUnlock').addEventListener('click',tryUnlock);
    $('fbLockPw').addEventListener('click',()=>{lockSet(null);auth.signOut().then(()=>location.reload());});
    $('fbForgot').addEventListener('click',async()=>{const em=$('fbEmail').value.trim();if(!em){$('fbGateMsg').textContent='Type your email first, then tap this again.';return;}
      try{await auth.sendPasswordResetEmail(em);$('fbGateMsg').textContent='Password reset email sent. Check your inbox.';}catch(err){$('fbGateMsg').textContent='Could not send the reset email.';}});
  });

  // ---------- Face ID lock (iPhone's own Face ID via WebAuthn; the face never leaves the phone) ----------
  const LK='hp-faceid';
  const b64=a=>btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const unb64=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
  const lockGet=()=>{try{return JSON.parse(localStorage.getItem(LK)||'null');}catch(e){return null;}};
  const lockSet=v=>{try{v?localStorage.setItem(LK,JSON.stringify(v)):localStorage.removeItem(LK);}catch(e){}};
  const rnd=n=>{const a=new Uint8Array(n);crypto.getRandomValues(a);return a;};
  async function lockSupported(){try{return !!(window.PublicKeyCredential&&await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());}catch(e){return false;}}
  async function faceCheck(){const L=lockGet();if(!L)return true;
    await navigator.credentials.get({publicKey:{challenge:rnd(32),allowCredentials:[{type:'public-key',id:unb64(L.id),transports:['internal']}],userVerification:'required',timeout:60000}});
    return true;}
  let unlockCb=null,hiddenAt=0;
  function showLock(on){const l=$('fbLock');if(l)l.hidden=!on;}
  async function tryUnlock(){$('fbLockMsg').textContent='';
    try{await faceCheck();showLock(false);if(unlockCb){const f=unlockCb;unlockCb=null;f();}}
    catch(e){$('fbLockMsg').textContent='Face ID did not unlock. Tap the button to try again.';}}
  function requireUnlock(then){if(!lockGet()){then&&then();return;}unlockCb=then||null;showLock(true);tryUnlock();}
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){hiddenAt=Date.now();return;}
    if(lockGet()&&started&&hiddenAt&&Date.now()-hiddenAt>60000&&$('fbLock')&&$('fbLock').hidden)requireUnlock();
  });
  window.fbLock={
    supported:lockSupported,
    enabled:()=>!!lockGet(),
    async enable(email){
      const cred=await navigator.credentials.create({publicKey:{challenge:rnd(32),rp:{name:'Hanjra Palace',id:location.hostname},
        user:{id:rnd(16),name:email||'ledger',displayName:'Hanjra Palace'},
        pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
        authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'discouraged'},timeout:60000,attestation:'none'}});
      lockSet({id:b64(cred.rawId),on:Date.now()});},
    async disable(){await faceCheck();lockSet(null);}
  };
  let started=false;
  auth.onAuthStateChanged(u=>{
    if(u&&ALLOWED&&u.email.toLowerCase()!==ALLOWED){auth.signOut();gate(true,'This account is not allowed to open this ledger.');return;}
    if(u){gate(false);if(!started){started=true;requireUnlock(ready);}}
    else{gate(true);if(started)location.reload();}
  });
})();
