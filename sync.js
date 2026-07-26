/* 端末間同期・グループ・みんなの集計（Supabase）
   元アプリ uploads/index.html の SYNC を、DOM 依存を外して移植したもの。
   ・未ログイン時は一切通信しない（load() を呼ばなければ import すら走らない）
   ・シーズン単位の Last-Write-Wins ＋ 試合単位マージ */
(function(){
  var SUPABASE_URL  = "https://vcccdzojztczostxmiay.supabase.co";
  var SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjY2Nkem9qenRjem9zdHhtaWF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMzUwNjAsImV4cCI6MjA5OTYxMTA2MH0.EQt2u27awFqxLqXhTqv16xBnEFbE2ICWk6L3Th4xcWI";

  var sb = null, user = null, cfg = null, ready = null;
  var pushTimer = null, busy = false, pendingAgain = false, deviceRO = false;

  function ls(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
  function localDoc(key){ try{ var r=ls(key); return r?JSON.parse(r):{}; }catch(e){ return {}; } }
  function atKey(k){ return k+"::at"; }
  function getAt(k){ return parseInt(ls(atKey(k)),10) || 0; }
  function setAt(k,t){ lsSet(atKey(k), String(t)); }
  function status(s){ if(cfg && cfg.onStatus) cfg.onStatus(s); }

  var DEVICE_ID = (function(){
    var v = ls("vegalta-device-id");
    if(!v){ v = "d-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,10); lsSet("vegalta-device-id", v); }
    return v;
  })();

  function configure(o){ cfg = o || {}; }

  function load(){
    if(ready) return ready;
    var timeout = new Promise(function(_,rej){ setTimeout(function(){ rej(new Error("timeout")); }, 15000); });
    var task = import("https://esm.sh/@supabase/supabase-js@2").then(function(mod){
      sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON);
      sb.auth.onAuthStateChange(function(_e, session){
        user = session ? session.user : null;
        afterAuth();
      });
      return sb.auth.getSession().then(function(res){
        user = (res.data && res.data.session) ? res.data.session.user : null;
        afterAuth();
      });
    });
    ready = Promise.race([task, timeout]).catch(function(e){
      ready = null; status("offline");
      throw e;
    });
    return ready;
  }

  function afterAuth(){
    if(cfg && cfg.onAuth) cfg.onAuth(user ? {id:user.id, email:user.email} : null);
    if(user) reconcile();
  }

  function docCount(o){ var n=0; for(var k in o){ if(o.hasOwnProperty(k)) n++; } return n; }
  function isEmptyRec(v){
    if(!v || typeof v!=="object") return true;
    for(var k in v){ if(v.hasOwnProperty(k)){
      var x=v[k];
      if(x!=="" && x!=null && !(Array.isArray(x)&&x.length===0)) return false;
    }}
    return true;
  }
  function mergeRecords(localRec, remoteRec, localNewer){
    var out={}, k;
    for(k in remoteRec){ if(remoteRec.hasOwnProperty(k) && !isEmptyRec(remoteRec[k])) out[k]=remoteRec[k]; }
    for(k in localRec){ if(localRec.hasOwnProperty(k) && !isEmptyRec(localRec[k])){
      if(!(k in out)) out[k]=localRec[k];
      else if(localNewer) out[k]=localRec[k];
    }}
    return out;
  }
  function sameRec(a,b){ try{ return JSON.stringify(a)===JSON.stringify(b); }catch(e){ return false; } }

  function reconcile(){
    if(!sb || !user) return Promise.resolve();
    if(busy){ pendingAgain = true; return Promise.resolve(); }
    busy = true; status("syncing");

    var SEASONS = (cfg && cfg.seasons) || [];
    var prevUid = ls("vegalta-last-uid");
    var everLoggedIn = (prevUid !== null && prevUid !== "");
    var cloudWins = everLoggedIn && (prevUid !== user.id);

    return sb.from("attendance_docs").select("season_id, records, updated_at").then(function(res){
      if(res.error) throw res.error;
      var remote = {};
      (res.data||[]).forEach(function(row){
        remote[row.season_id] = { records: row.records||{}, at: new Date(row.updated_at).getTime() };
      });
      var dv = remote["__device"];
      deviceRO = !!(dv && dv.records && dv.records.device_id && dv.records.device_id !== DEVICE_ID);
      if(cfg && cfg.onReadonly) cfg.onReadonly(deviceRO);

      var pushes = [], adopted = false;
      if(!deviceRO && !(dv && dv.records && dv.records.device_id)){
        pushes.push({ user_id:user.id, season_id:"__device",
          records:{ device_id: DEVICE_ID }, updated_at:new Date().toISOString() });
      }

      SEASONS.forEach(function(s){
        var localAt = getAt(s.key), r = remote[s.id], remoteAt = r ? r.at : 0;
        var localRec = localDoc(s.key), remoteRec = r ? (r.records||{}) : {};
        var merged, mergedAt;
        if(cloudWins){
          merged = {};
          for(var rk in remoteRec){ if(remoteRec.hasOwnProperty(rk) && !isEmptyRec(remoteRec[rk])) merged[rk]=remoteRec[rk]; }
          mergedAt = remoteAt || Date.now();
          if(!sameRec(merged, localRec)){ lsSet(s.key, JSON.stringify(merged)); setAt(s.key, mergedAt); adopted = true; }
          return;
        }
        if(docCount(localRec)===0 && docCount(remoteRec)===0) return;
        merged = mergeRecords(localRec, remoteRec, localAt >= remoteAt);
        mergedAt = Math.max(localAt, remoteAt) || Date.now();
        if(!sameRec(merged, localRec)){ lsSet(s.key, JSON.stringify(merged)); setAt(s.key, mergedAt); adopted = true; }
        if(!deviceRO && !sameRec(merged, remoteRec)){
          pushes.push({ user_id:user.id, season_id:s.id, records:merged, updated_at:new Date(mergedAt).toISOString() });
        }
      });

      if(cloudWins){ lsDel("vegalta-nickname"); }
      if(adopted && cfg && cfg.onAdopt) cfg.onAdopt();

      return pushes.length
        ? sb.from("attendance_docs").upsert(pushes, { onConflict:"user_id,season_id" })
        : { data:null, error:null };
    }).then(function(res){
      if(res && res.error) throw res.error;
      if(deviceRO) return { data:null, error:null };
      var contribs = (cfg && cfg.buildContributions) ? cfg.buildContributions() : [];
      if(!contribs.length) return { data:null, error:null };
      var nowIso = new Date().toISOString();
      var rowsC = contribs.map(function(c){
        return { user_id:user.id, season_id:c.season_id, payload:c.payload, updated_at:nowIso };
      });
      return sb.from("pref_contributions").upsert(rowsC, { onConflict:"user_id,season_id" }).then(function(r){
        var keep = rowsC.map(function(x){ return '"'+x.season_id+'"'; }).join(",");
        return sb.from("pref_contributions").delete().eq("user_id", user.id)
          .not("season_id","in","("+keep+")").then(function(){ return r; }, function(){ return r; });
      });
    }).then(function(res2){
      if(res2 && res2.error) console.warn("[community]", res2.error);
      var gid = (cfg && cfg.activeGroupId) ? cfg.activeGroupId() : "";
      if(deviceRO || !gid) return { data:null, error:null };
      return writeMyPlans(gid);
    }).then(function(res3){
      if(res3 && res3.error) console.warn("[group]", res3.error);
      busy = false;
      var now = Date.now();
      lsSet("vegalta-last-sync", String(now));
      lsSet("vegalta-last-uid", user.id);
      status("ok");
      if(pendingAgain){ pendingAgain = false; schedulePush(); }
    }).catch(function(err){
      busy = false; status("error");
      console.error("[sync]", err);
      pendingAgain = false;
      throw err;
    });
  }

  function schedulePush(){
    if(!sb || !user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function(){ reconcile().catch(function(){}); }, 1500);
  }

  function signUp(email, pass){
    if(!sb) return Promise.resolve({error:"同期機能を読み込めませんでした"});
    return sb.auth.signUp({email:email, password:pass})
      .then(function(r){ return { error: r.error ? (r.error.message||"unknown") : null }; });
  }
  function signIn(email, pass){
    if(!sb) return Promise.resolve({error:"同期機能を読み込めませんでした"});
    return sb.auth.signInWithPassword({email:email, password:pass})
      .then(function(r){ return { error: r.error ? (r.error.message||"unknown") : null }; });
  }
  function sendReset(email){
    if(!sb) return Promise.resolve("同期機能を読み込めませんでした");
    return sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })
      .then(function(r){ return r.error ? (r.error.message||"unknown") : null; })
      .catch(function(e){ return (e && (e.message||e.name)) ? String(e.message||e.name) : "unknown"; });
  }
  function updatePassword(pass){
    if(!sb) return Promise.resolve("ログインしていません");
    return sb.auth.updateUser({password:pass}).then(function(r){ return r.error ? (r.error.message||"unknown") : null; });
  }
  function signOut(){
    if(!sb) return Promise.resolve();
    return sb.auth.signOut().then(function(){
      user = null; lsDel("vegalta-mode");
      if(cfg && cfg.onAuth) cfg.onAuth(null);
    });
  }
  function deleteAccount(){
    if(!sb || !user) return Promise.resolve("ログインしていません");
    return sb.rpc("delete_own_account").then(function(res){
      if(res.error) return res.error.message||"unknown";
      return sb.auth.signOut().then(function(){
        lsDel("vegalta-mode"); lsDel("vegalta-last-uid"); lsDel("vegalta-last-sync");
        ((cfg&&cfg.seasons)||[]).forEach(function(s){ lsDel(s.key); lsDel(atKey(s.key)); });
        user = null;
        if(cfg && cfg.onAuth) cfg.onAuth(null);
        return null;
      });
    }).catch(function(e){ return e.message || String(e); });
  }

  function fetchCommunity(seasonId){
    if(!sb) return Promise.resolve({error:"未接続"});
    var p = { p_season_id: (seasonId && seasonId!=="__all") ? seasonId : null };
    return Promise.all([sb.rpc("community_pref_stats", p), sb.rpc("community_totals", p)]).then(function(rs){
      var a=rs[0], b=rs[1];
      if(a.error) return { error:a.error.message||"集計取得に失敗" };
      if(b.error) return { error:b.error.message||"集計取得に失敗" };
      return { prefs:a.data||[], totals:(b.data&&b.data[0])||{total_users:0,total_spend:0,total_visits:0} };
    }).catch(function(e){ return { error:String(e&&e.message||e) }; });
  }

  function createGroup(name, nick){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    return sb.rpc("create_group", {p_name:name, p_nickname:nick}).then(function(res){
      if(res.error) return { error:res.error.message };
      var row=(res.data&&res.data[0])||{};
      return { group_id:row.group_id, invite_code:row.invite_code };
    });
  }
  function joinGroup(code, nick){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    return sb.rpc("join_group", {p_code:code, p_nickname:nick}).then(function(res){
      return res.error ? { error:res.error.message } : { group_id:res.data };
    });
  }
  function myGroups(){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    return sb.from("group_members").select("group_id, nickname, groups(name, invite_code, created_by)")
      .eq("user_id", user.id).then(function(res){
        if(res.error) return { error:res.error.message };
        var seen={}, out=[];
        (res.data||[]).forEach(function(r){
          if(!r || !r.group_id || seen[r.group_id]) return;
          seen[r.group_id]=true;
          out.push({ group_id:r.group_id, nickname:r.nickname,
            name:(r.groups&&r.groups.name)||"(名称不明)",
            invite_code:(r.groups&&r.groups.invite_code)||"",
            is_owner:!!(r.groups && r.groups.created_by===user.id) });
        });
        return { groups: out };
      });
  }
  function groupMembers(gid){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    if(!gid) return Promise.resolve({members:[]});
    return sb.from("group_members").select("user_id, nickname, groups(created_by)")
      .eq("group_id", gid).then(function(res){
        if(res.error) return { error:res.error.message };
        var seen={}, out=[];
        (res.data||[]).forEach(function(r){
          if(!r || !r.user_id || seen[r.user_id]) return;
          seen[r.user_id]=true;
          out.push({ user_id:r.user_id, nickname:r.nickname||"(名前未設定)",
            is_me:r.user_id===user.id, is_owner:!!(r.groups && r.groups.created_by===r.user_id) });
        });
        out.sort(function(a,b){
          if(a.is_me!==b.is_me) return a.is_me?-1:1;
          if(a.is_owner!==b.is_owner) return a.is_owner?-1:1;
          return String(a.nickname).localeCompare(String(b.nickname),"ja");
        });
        return { members: out };
      });
  }
  function groupPlans(gid){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    return sb.rpc("group_plans", {p_group_id:gid}).then(function(res){
      return res.error ? { error:res.error.message } : { rows:res.data||[] };
    });
  }
  function updateNickname(nick){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    return sb.from("group_members").update({nickname:nick}).eq("user_id", user.id)
      .then(function(res){ return res.error ? {error:res.error.message} : {ok:true}; });
  }
  function renameGroup(gid, name){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    var nm=String(name||"").trim().slice(0,30);
    if(!nm) return Promise.resolve({error:"グループ名を入力してください"});
    return sb.from("groups").update({name:nm}).eq("id",gid).eq("created_by",user.id).select("id,name")
      .then(function(res){
        if(res.error) return { error:res.error.message };
        if(!res.data || !res.data.length) return { error:"グループ名を変更できませんでした。作成者のみ変更できます" };
        return { ok:true, name:(res.data[0]&&res.data[0].name)||nm };
      });
  }
  function leaveGroup(gid){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    return sb.rpc("leave_group", {p_group_id:gid}).then(function(res){
      return res.error ? {error:res.error.message} : {ok:true};
    });
  }
  function deleteGroup(gid){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    return sb.rpc("delete_group", {p_group_id:gid}).then(function(res){
      return res.error ? {error:res.error.message} : {ok:true};
    });
  }
  function writeMyPlans(gid){
    if(!sb || !user) return Promise.resolve({error:"ログインが必要です"});
    var plans = (cfg && cfg.buildMyPlans) ? cfg.buildMyPlans() : [];
    var anyLocal = false;
    ((cfg&&cfg.seasons)||[]).forEach(function(s){
      var raw = ls(s.key);
      if(raw){ try{ var o=JSON.parse(raw); for(var k in o){ if(o.hasOwnProperty(k)){ anyLocal=true; break; } } }catch(e){ anyLocal=true; } }
    });
    if(!anyLocal) return Promise.resolve({data:null, skipped:true});
    var keepIds = plans.map(function(p){ return p.match_id; });
    var nowIso = new Date().toISOString();
    var rows = plans.map(function(p){
      return { group_id:gid, user_id:user.id, match_id:p.match_id, status:p.status, updated_at:nowIso };
    });
    var up = rows.length ? sb.from("member_plans").upsert(rows, {onConflict:"group_id,user_id,match_id"})
                         : Promise.resolve({error:null});
    return up.then(function(res){
      if(res && res.error) return { error:res.error.message };
      var del = sb.from("member_plans").delete().eq("group_id",gid).eq("user_id",user.id);
      if(keepIds.length){
        del = del.not("match_id","in","("+keepIds.map(function(id){ return '"'+String(id).replace(/"/g,"")+'"'; }).join(",")+")");
      }
      return del.then(function(r2){ return (r2 && r2.error) ? {error:r2.error.message} : {ok:true}; });
    });
  }

  window.VGSync = {
    configure: configure, load: load,
    sync: function(){ return reconcile(); }, schedulePush: schedulePush,
    signUp: signUp, signIn: signIn, sendReset: sendReset, updatePassword: updatePassword,
    signOut: signOut, deleteAccount: deleteAccount,
    fetchCommunity: fetchCommunity,
    createGroup: createGroup, joinGroup: joinGroup, myGroups: myGroups,
    groupMembers: groupMembers, groupPlans: groupPlans, pushMyPlans: writeMyPlans,
    updateNickname: updateNickname, renameGroup: renameGroup, leaveGroup: leaveGroup, deleteGroup: deleteGroup,
    isReadonly: function(){ return deviceRO; },
    lastSync: function(){ return parseInt(ls("vegalta-last-sync"),10)||0; },
    currentUser: function(){ return user ? {id:user.id, email:user.email} : null; },
    deviceId: DEVICE_ID
  };
})();
