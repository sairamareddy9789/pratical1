import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import "./App.css";

/* ---------- constants & helpers ---------- */
const KEY = "votesecure_v4_state";
const ADMIN = { username: "admin", password: "admin123", name: "Election Admin", phone: "9000000001" };
const DEMO_VOTER = { id: "VOTER001", password: "voter123", name: "Demo Voter", phone: "9876543210" };
const toLocalInput = (ts) => { const d = new Date(ts); return new Date(ts - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fmt = (ts) => new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const mask = (p) => p.slice(0, 2) + "******" + p.slice(-2);
const duration = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${s % 60}s` : `${m}m ${s % 60}s`;
};
async function makeReceipt(voterId, cid) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${voterId}:${cid}:${Date.now()}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16).toUpperCase();
}

const seed = () => {
  const e1 = "e" + Date.now();
  return {
    voters: { [DEMO_VOTER.id]: { name: DEMO_VOTER.name, phone: DEMO_VOTER.phone, password: DEMO_VOTER.password } },
    elections: {
      [e1]: {
        id: e1,
        title: "Student Council Election",
        candidates: [
          { id: "c1", name: "Anika Rao", party: "Progress Alliance", pledge: "Free campus Wi-Fi and 24/7 library access" },
          { id: "c2", name: "Marcus Dell", party: "Student Voice", pledge: "Transparent budgets and open council meetings" },
          { id: "c3", name: "Priya Nair", party: "Green Future", pledge: "Zero-waste campus and cycle lanes" },
        ],
        votes: {}, voted: {}, announced: false, suspended: false,
        schedule: { start: Date.now() - 3600e3, end: Date.now() + 2 * 86400e3 },
      },
    },
    activeElectionId: e1,
    session: null,
  };
};

/* ---------- reducer + hooks ---------- */
function editElection(s, id, fn) {
  const el = s.elections[id];
  if (!el) return s;
  return { ...s, elections: { ...s.elections, [id]: fn(el) } };
}
function reducer(s, a) {
  switch (a.type) {
    case "REGISTER": return { ...s, voters: { ...s.voters, [a.id]: a.voter } };
    case "RESET_PASSWORD": return s.voters[a.id] ? { ...s, voters: { ...s.voters, [a.id]: { ...s.voters[a.id], password: a.password } } } : s;
    case "SYNC": return { ...a.state, session: s.session }; // state changed in another tab; keep this tab's login
    case "LOGIN": return { ...s, session: a.session };
    case "LOGOUT": return { ...s, session: null };
    case "ADD_ELECTION": {
      const id = "e" + Date.now();
      return {
        ...s,
        elections: {
          ...s.elections,
          [id]: { id, title: a.title, candidates: [], votes: {}, voted: {}, announced: false, suspended: false, schedule: { start: Date.now(), end: Date.now() + 86400e3 } },
        },
        activeElectionId: id,
      };
    }
    case "REMOVE_ELECTION": {
      const rest = { ...s.elections };
      delete rest[a.id];
      const ids = Object.keys(rest);
      return { ...s, elections: rest, activeElectionId: s.activeElectionId === a.id ? (ids[0] || null) : s.activeElectionId };
    }
    case "SET_ACTIVE_ELECTION": return { ...s, activeElectionId: a.id };
    case "ADD_CAND": return editElection(s, a.electionId, (el) => ({ ...el, candidates: [...el.candidates, { id: "c" + Date.now(), ...a.cand }] }));
    case "REMOVE_CAND": return editElection(s, a.electionId, (el) => ({ ...el, candidates: el.candidates.filter((c) => c.id !== a.id) }));
    case "SET_SCHEDULE": return editElection(s, a.electionId, (el) => ({ ...el, schedule: a.schedule }));
    case "TOGGLE_SUSPEND": return editElection(s, a.electionId, (el) => ({ ...el, suspended: !el.suspended }));
    case "ANNOUNCE": return editElection(s, a.electionId, (el) => ({ ...el, announced: a.value }));
    case "CAST_VOTE":
      return editElection(s, a.electionId, (el) => {
        if (el.voted[a.voterId] || getStatus(el, Date.now()).key !== "open") return el; // ignore votes outside the open window
        return { ...el, votes: { ...el.votes, [a.cid]: (el.votes[a.cid] || 0) + 1 }, voted: { ...el.voted, [a.voterId]: a.receipt } };
      });
    case "RESET_ELECTION": return editElection(s, a.electionId, (el) => ({ ...el, votes: {}, voted: {}, announced: false, suspended: false }));
    default: return s;
  }
}
function usePersistentReducer() {
  const [state, dispatch] = useReducer(reducer, null, () => {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) return s; } catch {}
    return seed();
  });
  const syncing = useRef(false);
  useEffect(() => {
    if (syncing.current) { syncing.current = false; return; } // came from another tab, don't echo it back
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  }, [state]);
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== KEY || !e.newValue) return;
      try { syncing.current = true; dispatch({ type: "SYNC", state: JSON.parse(e.newValue) }); } catch { syncing.current = false; }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return [state, dispatch];
}
function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
function getStatus(el, now) {
  const { start, end } = el?.schedule || {};
  if (!el) return { key: "unset", label: "Not available", note: "" };
  if (!start || !end) return { key: "unset", label: "Not scheduled", note: "" };
  if (el.suspended) return { key: "paused", label: "Paused by admin", note: "" };
  if (now < start) return { key: "upcoming", label: "Voting not open yet", note: `Opens in ${duration(start - now)}` };
  if (now > end) return { key: "closed", label: "Voting closed", note: `Closed ${fmt(end)}` };
  return { key: "open", label: "Voting open", note: `Closes in ${duration(end - now)}` };
}
function computeTally(el) {
  if (!el) return { total: 0, rows: [], winners: [] };
  const total = Object.values(el.votes).reduce((a, b) => a + b, 0);
  const rows = el.candidates.map((c) => ({ ...c, n: el.votes[c.id] || 0, pct: total ? Math.round(((el.votes[c.id] || 0) / total) * 100) : 0 }));
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  const top = sorted[0]?.n || 0;
  const winners = total ? sorted.filter((r) => r.n === top) : [];
  return { total, rows, winners };
}
function useTally(el) {
  return useMemo(() => computeTally(el), [el]);
}

/* ---------- live status ---------- */
function LiveStatus({ election, now, showBar = true }) {
  const st = getStatus(election, now);
  const { start, end } = election.schedule || {};
  const pct = start && end ? Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100)) : 0;
  return (
    <div className={"live " + st.key}>
      <div className="live-top">
        <span className="dot" aria-hidden="true" />
        <strong role="status">{st.label}</strong>
        {st.note && <span className="live-note">{st.note}</span>}
      </div>
      {showBar && start && end && (
        <>
          <div className="live-bar" aria-hidden="true"><div style={{ width: pct + "%" }} /></div>
          <div className="live-times small"><span>{fmt(start)}</span><span>{fmt(end)}</span></div>
        </>
      )}
    </div>
  );
}

const TOAST_TEXT = {
  open: (t) => `“${t}” is now open for voting.`,
  closed: (t) => `Voting for “${t}” has closed.`,
  paused: (t) => `Voting for “${t}” was paused by the admin.`,
};
function StatusToasts() {
  const { state } = useApp();
  const now = useNow();
  const prev = useRef(null);
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const next = {}, fresh = [];
    Object.values(state.elections).forEach((el) => {
      const key = getStatus(el, now).key;
      next[el.id] = key;
      const before = prev.current?.[el.id];
      if (before && before !== key && TOAST_TEXT[key]) fresh.push({ id: el.id + key + now, key, text: TOAST_TEXT[key](el.title) });
    });
    prev.current = next;
    if (!fresh.length) return;
    setToasts((t) => [...t, ...fresh]);
    fresh.forEach((f) => setTimeout(() => setToasts((t) => t.filter((x) => x.id !== f.id)), 7000));
  }, [state.elections, now]);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="region" aria-label="Live updates">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + t.key}>
          <span>{t.text}</span>
          <button aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>✕</button>
        </div>
      ))}
    </div>
  );
}

const Ctx = createContext(null);
const useApp = () => useContext(Ctx);

/* ---------- root ---------- */
export default function App() {
  const [state, dispatch] = usePersistentReducer();
  const [page, setPage] = useState("home");
  const [focusId, setFocusId] = useState(null); // election to pre-select on the results page
  const go = useCallback((p, id = null) => { setPage(p); setFocusId(id); window.scrollTo(0, 0); }, []);
  const role = state.session?.role;

  let view = <Home />;
  if (page === "login") view = <AuthPage role="voter" mode="login" />;
  else if (page === "register") view = <AuthPage role="voter" mode="register" />;
  else if (page === "reset") view = <ResetPassword />;
  else if (page === "admin-login") view = <AuthPage role="admin" mode="login" />;
  else if (page === "verify") view = <VerifyReceipt />;
  else if (page === "results") view = <ResultsPage />;
  else if (page === "dashboard" && role === "admin") view = <AdminPanel />;
  else if (page === "dashboard" && role === "voter") view = <VoterDashboard />;

  return (
    <Ctx.Provider value={{ state, dispatch, go, page, focusId }}>
      <Header />
      {view}
      <StatusToasts />
    </Ctx.Provider>
  );
}

function Header() {
  const { state, dispatch, go, page } = useApp();
  const me = state.session;
  const [open, setOpen] = useState(false);
  const announced = Object.values(state.elections).filter((el) => el.announced).length;
  const nav = (p) => { setOpen(false); go(p); };
  const link = (p, label, badge) => (
    <button key={p} className={"navlink" + (page === p ? " active" : "")} aria-current={page === p ? "page" : undefined} onClick={() => nav(p)}>
      {label}{badge > 0 && <span className="badge">{badge}</span>}
    </button>
  );
  return (
    <header className="top">
      <button className="brand" onClick={() => nav("home")} aria-label="VoteSecure home">
        <span className="logo" aria-hidden="true">✓</span>VoteSecure
      </button>
      <button className="burger" aria-label="Toggle menu" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "✕" : "☰"}</button>
      <nav className={open ? "open" : ""} aria-label="Main">
        <div className="navlinks">
          {link("home", "Home")}
          {link("results", "Results", announced)}
          {link("verify", "Verify receipt")}
          {me && link("dashboard", me.role === "admin" ? "Admin panel" : "My elections")}
        </div>
        <div className="navauth">
          {me ? (
            <>
              <span className="who">{me.name} ({me.role})</span>
              <button className="ghost light" onClick={() => { setOpen(false); dispatch({ type: "LOGOUT" }); go("home"); }}>Log out</button>
            </>
          ) : (
            <>
              <button className="ghost light" onClick={() => nav("login")}>Login</button>
              <button className="ghost light" onClick={() => nav("register")}>Register</button>
              <button className="ghost light" onClick={() => nav("admin-login")}>Admin</button>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

/* ---------- home ---------- */
function Home() {
  const { state, go } = useApp();
  const now = useNow();
  const elections = Object.values(state.elections);
  const announcedElections = elections.filter((el) => el.announced);
  const openCount = elections.filter((el) => getStatus(el, now).key === "open").length;
  const features = [
    ["OTP-verified identity", "Name, voter ID and mobile number are checked, then a one-time code confirms it’s really you."],
    ["One voter, one vote", "Your ballot locks the moment you confirm, in every election you’re eligible for."],
    ["Verifiable receipts", "You get a unique code and can check it anytime to prove your vote was counted, without revealing your choice."],
    ["Multiple elections, one account", "The admin can run several elections at once — council, clubs, referenda — side by side."],
    ["Forgot password? No problem", "Reset your password yourself with an OTP, no admin needed."],
    ["Admin-controlled elections", "The admin sets dates, manages candidates, pauses voting and announces each result."],
  ];
  return (
    <main>
      <section className="hero">
        <div>
          <span className="eyebrow">Secure · Transparent · Verifiable</span>
          <h1>Vote from anywhere. Every vote counted once.</h1>
          <p className="lede">VoteSecure is an online voting system for college and community elections. Register, verify with an OTP, vote during the window the admin sets, and see the announced result.</p>
          <div className="cta">
            <button className="primary" onClick={() => go("login")}>Login</button>
            <button className="secondary" onClick={() => go("register")}>Register</button>
            <button className="ghost" onClick={() => go("results")}>View results</button>
            <button className="ghost" onClick={() => go("verify")}>Verify receipt</button>
          </div>
        </div>
        <aside className="status-card">
          <h2>Elections running</h2>
          <p className="big">{elections.length}</p>
          <p className="small">{Object.keys(state.voters).length} registered voters</p>
          <p className="live-count"><span className={"dot" + (openCount ? " on" : "")} aria-hidden="true" />{openCount} open for voting right now</p>
          {elections.length > 0 && (
            <ul className="election-mini-list">
              {elections.map((el) => {
                const st = getStatus(el, now);
                return (
                  <li key={el.id}>
                    <span>{el.title}</span>
                    <span className={"pill " + st.key}>{st.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </section>

      <section className="band">
        <div className="band-head">
          <h2>Latest announced results</h2>
          <button className="link" onClick={() => go("results")}>See all results →</button>
        </div>
        {announcedElections.length === 0 ? (
          <p className="notice">No results have been announced yet. They will appear here once the admin publishes them after voting closes.</p>
        ) : (
          <div className="demo-grid">
            {announcedElections.map((el) => {
              const t = computeTally(el);
              return (
                <div className="demo" key={el.id}>
                  <h3>{el.title}</h3>
                  <span className="pill closed">Result announced</span>
                  <p className="small">{t.total ? `${t.winners.length > 1 ? "Tie" : "Winner"}: ${t.winners.map((w) => w.name).join(" & ")}` : "No votes were cast."}</p>
                  <p className="small">{t.total} votes cast</p>
                  <button className="primary" onClick={() => go("results", el.id)}>View full result</button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="band">
        <h2>What VoteSecure does</h2>
        <dl className="features">
          {features.map(([t, d]) => (<div key={t}><dt>{t}</dt><dd>{d}</dd></div>))}
        </dl>
      </section>

      <section className="band">
        <h2>How voting works</h2>
        <ol className="steps">
          <li>Register with your name, voter ID and mobile number.</li>
          <li>Log in and enter the OTP sent to your phone.</li>
          <li>Pick whichever open election you’re voting in, choose a candidate and confirm.</li>
          <li>Keep your receipt, verify it anytime, and check the results once announced.</li>
        </ol>
      </section>

      <section className="band" id="demo">
        <h2>Demo accounts for judges</h2>
        <p className="sub">OTPs appear on screen in demo mode because no SMS gateway is connected.</p>
        <div className="demo-grid">
          <div className="demo"><h3>Voter</h3><p>Voter ID: <b>{DEMO_VOTER.id}</b></p><p>Password: <b>{DEMO_VOTER.password}</b></p><p>Name: <b>{DEMO_VOTER.name}</b></p><p>Phone: <b>{DEMO_VOTER.phone}</b></p><button className="primary" onClick={() => go("login")}>Go to voter login</button></div>
          <div className="demo"><h3>Admin</h3><p>Username: <b>{ADMIN.username}</b></p><p>Password: <b>{ADMIN.password}</b></p><p>Name: <b>{ADMIN.name}</b></p><p>Phone: <b>{ADMIN.phone}</b></p><button className="primary" onClick={() => go("admin-login")}>Go to admin login</button></div>
          <div className="demo"><h3>New voter</h3><p>Create your own account, verify by OTP, and vote.</p><button className="secondary" onClick={() => go("register")}>Register</button></div>
        </div>
      </section>
      <footer className="foot">
        <nav className="foot-links" aria-label="Footer">
          <button className="link" onClick={() => go("home")}>Home</button>
          <button className="link" onClick={() => go("results")}>Results</button>
          <button className="link" onClick={() => go("verify")}>Verify receipt</button>
          <button className="link" onClick={() => go("login")}>Voter login</button>
          <button className="link" onClick={() => go("admin-login")}>Admin</button>
        </nav>
        VoteSecure v5 · Hackathon project
      </footer>
    </main>
  );
}

/* ---------- auth + otp ---------- */
function OtpStep({ phone, onVerified, onBack }) {
  const gen = () => String(Math.floor(100000 + Math.random() * 900000));
  const [otp, setOtp] = useState(gen);
  const [expires, setExpires] = useState(Date.now() + 120000);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const now = useNow();
  const left = Math.max(0, Math.ceil((expires - now) / 1000));
  const resend = () => { setOtp(gen()); setExpires(Date.now() + 120000); setInput(""); setErr(""); };
  const verify = (e) => {
    e.preventDefault();
    if (left === 0) return setErr("This OTP has expired. Send a new one.");
    if (input !== otp) return setErr("Incorrect OTP. Check the code and try again.");
    onVerified();
  };
  return (
    <form className="panel" onSubmit={verify}>
      <h2>Enter the OTP</h2>
      <p>We sent a 6-digit code to +91 {mask(phone)}.</p>
      <div className="sms"><b>SMS simulator</b><br />Your VoteSecure OTP is <code>{otp}</code>. Valid for 2 minutes.</div>
      <label>6-digit OTP<input inputMode="numeric" maxLength={6} value={input} onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))} autoFocus /></label>
      <p className="small">{left > 0 ? `Expires in ${left}s` : "Expired"}</p>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="primary" type="submit">Verify and continue</button>
      <div className="row"><button type="button" className="ghost" onClick={resend}>Resend OTP</button><button type="button" className="ghost" onClick={onBack}>Change details</button></div>
    </form>
  );
}

function AuthPage({ role, mode }) {
  const { state, dispatch, go } = useApp();
  const isAdmin = role === "admin", isReg = mode === "register";
  const [f, setF] = useState({ id: "", password: "", name: "", phone: "" });
  const [pending, setPending] = useState(null);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const demo = isAdmin ? { id: ADMIN.username, password: ADMIN.password, name: ADMIN.name, phone: ADMIN.phone } : DEMO_VOTER;

  function submit(e) {
    e.preventDefault(); setErr("");
    const id = isAdmin ? f.id.trim().toLowerCase() : f.id.trim().toUpperCase();
    const name = f.name.trim(), phone = f.phone.trim();
    if (!name) return setErr("Enter your full name.");
    if (!id) return setErr(isAdmin ? "Enter the admin username." : "Enter your voter ID.");
    if (!/^[6-9]\d{9}$/.test(phone)) return setErr("Enter a valid 10-digit mobile number.");
    if (isReg) {
      if (!/^[A-Z0-9]{4,12}$/.test(id)) return setErr("Voter ID must be 4–12 letters or numbers.");
      if (f.password.length < 6) return setErr("Password must be at least 6 characters.");
      if (state.voters[id]) return setErr("This voter ID is already registered. Log in instead.");
      if (Object.values(state.voters).some((v) => v.phone === phone)) return setErr("This mobile number is already registered.");
    } else if (isAdmin) {
      if (id !== ADMIN.username || f.password !== ADMIN.password || name.toLowerCase() !== ADMIN.name.toLowerCase() || phone !== ADMIN.phone)
        return setErr("These details don’t match the admin account.");
    } else {
      const v = state.voters[id];
      if (!v || v.password !== f.password || v.name.toLowerCase() !== name.toLowerCase() || v.phone !== phone)
        return setErr("These details don’t match a registered voter. Check voter ID, password, name and phone.");
    }
    setPending({ id, name, phone, password: f.password });
  }
  function verified() {
    if (isReg) dispatch({ type: "REGISTER", id: pending.id, voter: { name: pending.name, phone: pending.phone, password: pending.password } });
    dispatch({ type: "LOGIN", session: { role, id: pending.id, name: pending.name } });
    go("dashboard");
  }

  return (
    <main className="auth">
      <section>
        <h1>{isAdmin ? "Admin login" : isReg ? "Register to vote" : "Voter login"}</h1>
        <p className="lede">{isAdmin ? "Verify your details and the OTP to manage the election." : "Confirm your name, voter ID and phone number. We’ll send an OTP to finish."}</p>
        {!isReg && <button className="ghost" type="button" onClick={() => { setF(demo); setPending(null); }}>Fill demo credentials</button>}
        {!isAdmin && (
          <p className="small">{isReg ? "Already registered?" : "New here?"}{" "}
            <button className="link" onClick={() => go(isReg ? "login" : "register")}>{isReg ? "Log in" : "Register"}</button></p>
        )}
        {!isAdmin && !isReg && (
          <p className="small"><button className="link" onClick={() => go("reset")}>Forgot your password?</button></p>
        )}
      </section>
      {pending ? (
        <OtpStep phone={pending.phone} onVerified={verified} onBack={() => setPending(null)} />
      ) : (
        <form className="panel" onSubmit={submit} noValidate>
          <label>Full name<input value={f.name} onChange={set("name")} autoComplete="name" /></label>
          <label>{isAdmin ? "Admin username" : "Voter ID"}<input value={f.id} onChange={set("id")} placeholder={isAdmin ? "admin" : "e.g. STU2026"} /></label>
          <label>Mobile number<input inputMode="numeric" maxLength={10} value={f.phone} onChange={set("phone")} placeholder="10-digit number" /></label>
          <label>Password<input type="password" value={f.password} onChange={set("password")} /></label>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="primary" type="submit">Send OTP</button>
        </form>
      )}
    </main>
  );
}

/* ---------- forgot password / reset ---------- */
function ResetPassword() {
  const { state, dispatch, go } = useApp();
  const [step, setStep] = useState("details"); // details -> otp -> newpass -> done
  const [f, setF] = useState({ id: "", name: "", phone: "" });
  const [newPass, setNewPass] = useState("");
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function submitDetails(e) {
    e.preventDefault(); setErr("");
    const id = f.id.trim().toUpperCase();
    const name = f.name.trim(), phone = f.phone.trim();
    const v = state.voters[id];
    if (!v || v.name.toLowerCase() !== name.toLowerCase() || v.phone !== phone)
      return setErr("These details don’t match a registered voter.");
    setF({ id, name, phone });
    setStep("otp");
  }
  function submitNewPass(e) {
    e.preventDefault(); setErr("");
    if (newPass.length < 6) return setErr("Password must be at least 6 characters.");
    dispatch({ type: "RESET_PASSWORD", id: f.id, password: newPass });
    setStep("done");
  }

  return (
    <main className="auth">
      <section>
        <h1>Reset your password</h1>
        <p className="lede">Confirm your voter ID, name and phone number, verify with an OTP, then set a new password.</p>
        <p className="small">Remembered it? <button className="link" onClick={() => go("login")}>Log in</button></p>
      </section>

      {step === "details" && (
        <form className="panel" onSubmit={submitDetails} noValidate>
          <label>Voter ID<input value={f.id} onChange={set("id")} placeholder="e.g. STU2026" /></label>
          <label>Full name<input value={f.name} onChange={set("name")} /></label>
          <label>Mobile number<input inputMode="numeric" maxLength={10} value={f.phone} onChange={set("phone")} placeholder="10-digit number" /></label>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="primary" type="submit">Send OTP</button>
        </form>
      )}

      {step === "otp" && <OtpStep phone={f.phone} onVerified={() => setStep("newpass")} onBack={() => setStep("details")} />}

      {step === "newpass" && (
        <form className="panel" onSubmit={submitNewPass}>
          <h2>Set a new password</h2>
          <label>New password<input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} /></label>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="primary" type="submit">Save new password</button>
        </form>
      )}

      {step === "done" && (
        <div className="panel">
          <h2>Password updated</h2>
          <p>You can now log in with your new password.</p>
          <button className="primary" onClick={() => go("login")}>Go to login</button>
        </div>
      )}
    </main>
  );
}

/* ---------- verify receipt ---------- */
function VerifyReceipt() {
  const { state } = useApp();
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const check = (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    const found = c && Object.values(state.elections).some((el) => Object.values(el.voted).includes(c));
    setResult(c && found ? "valid" : "invalid");
  };
  return (
    <main className="auth">
      <section>
        <h1>Verify your receipt</h1>
        <p className="lede">Enter the receipt code you got after voting to confirm your ballot was counted. Your choice stays private.</p>
      </section>
      <form className="panel" onSubmit={check}>
        <label>Receipt code<input value={code} onChange={(e) => { setCode(e.target.value); setResult(null); }} placeholder="e.g. 3F9A1C0B7D2E4A55" /></label>
        {result === "valid" && <p className="ok">Valid: this ballot was recorded and counted.</p>}
        {result === "invalid" && <p className="error">No ballot found with this code.</p>}
        <button className="primary" type="submit">Verify</button>
      </form>
    </main>
  );
}

/* ---------- public results page ---------- */
function ResultsPage() {
  const { state, go, focusId } = useApp();
  const now = useNow();
  const elections = Object.values(state.elections);
  const announced = elections.filter((el) => el.announced);
  const pending = elections.filter((el) => !el.announced);
  const [selId, setSelId] = useState(() => (focusId && state.elections[focusId]?.announced ? focusId : announced[0]?.id || null));
  const el = announced.find((e) => e.id === selId) || announced[0];
  const tally = useTally(el);
  const voterCount = Object.keys(state.voters).length;
  const turnout = voterCount ? Math.round((tally.total / voterCount) * 100) : 0;
  const ranked = [...tally.rows].sort((a, b) => b.n - a.n);
  const winnerIds = new Set(tally.winners.map((w) => w.id));

  return (
    <main className="content wide">
      <section className="page-head">
        <h1>Election results</h1>
        <p className="lede">Official results published by the admin. Only elections whose results have been announced are shown here.</p>
      </section>

      {announced.length === 0 ? (
        <p className="notice">No results have been announced yet. Check back after voting closes and the admin publishes the outcome.</p>
      ) : (
        <>
          {announced.length > 1 && (
            <div className="tabs" role="tablist" aria-label="Elections">
              {announced.map((e) => (
                <button key={e.id} role="tab" aria-selected={el.id === e.id} className={el.id === e.id ? "on" : ""} onClick={() => setSelId(e.id)}>{e.title}</button>
              ))}
            </div>
          )}

          <h2 className="election-heading">{el.title}</h2>
          <WinnerBanner tally={tally} />

          <div className="stats">
            <div><b>{tally.total}</b><span>Votes cast</span></div>
            <div><b>{turnout}%</b><span>Turnout ({voterCount} registered)</span></div>
            <div><b>{el.candidates.length}</b><span>Candidates</span></div>
            <div><b className="stat-sm">{fmt(el.schedule.end)}</b><span>Voting closed</span></div>
          </div>

          <h3>Vote share</h3>
          <div className="bars">
            {ranked.map((c) => (
              <div key={c.id}>
                <div className="bar-label"><strong>{c.name}{winnerIds.has(c.id) && <span className="crown" title="Winner"> 🏆</span>}</strong><span>{c.n} votes ({c.pct}%)</span></div>
                <div className="track"><div className={"fill" + (winnerIds.has(c.id) ? " win" : "")} style={{ width: c.pct + "%" }} /></div>
              </div>
            ))}
          </div>

          <h3>Full standings</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Rank</th><th>Candidate</th><th>Party</th><th>Votes</th><th>Share</th></tr></thead>
            <tbody>
              {ranked.map((c, i) => (
                <tr key={c.id} className={winnerIds.has(c.id) ? "row-win" : ""}>
                  <td>{ranked.findIndex((r) => r.n === c.n) + 1}</td><td>{c.name}</td><td>{c.party}</td><td>{c.n}</td><td>{c.pct}%</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <p className="small">Want to confirm your own ballot was counted? <button className="link" onClick={() => go("verify")}>Verify your receipt</button></p>
        </>
      )}

      {pending.length > 0 && (
        <section className="band results-pending">
          <h2>Awaiting announcement</h2>
          <ul className="election-mini-list wide-list">
            {pending.map((e) => {
              const st = getStatus(e, now);
              return (
                <li key={e.id}>
                  <span>{e.title}</span>
                  <span className={"pill " + st.key}>{st.label}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}

/* ---------- shared ---------- */
function ResultBars({ tally }) {
  return (
    <div className="bars">
      {tally.rows.map((c) => (
        <div key={c.id}>
          <div className="bar-label"><strong>{c.name}</strong><span>{c.n} votes ({c.pct}%)</span></div>
          <div className="track"><div className="fill" style={{ width: c.pct + "%" }} /></div>
        </div>
      ))}
    </div>
  );
}
function WinnerBanner({ tally }) {
  if (!tally.total) return <p className="notice">No votes were cast.</p>;
  const names = tally.winners.map((w) => w.name).join(" and ");
  return <div className="winner"><span>{tally.winners.length > 1 ? "Tie between" : "Winner"}</span><strong>{names}</strong></div>;
}
function Tabs({ tabs, tab, setTab }) {
  return <div className="tabs" role="tablist">{tabs.map(([k, l]) => (<button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>))}</div>;
}

/* ---------- voter dashboard (election list + per-election ballot) ---------- */
function VoterDashboard() {
  const { state } = useApp();
  const [selected, setSelected] = useState(null);
  const now = useNow();
  const elections = Object.values(state.elections);
  const me = state.session;

  if (selected && state.elections[selected]) {
    return <ElectionVoter election={state.elections[selected]} onBack={() => setSelected(null)} />;
  }

  return (
    <main className="content wide">
      <h1>Your elections</h1>
      {elections.length === 0 ? (
        <p className="notice">No elections have been set up yet. Check back once the admin creates one.</p>
      ) : (
        <div className="demo-grid">
          {elections.map((el) => {
            const voted = el.voted[me.id];
            return (
              <div className="demo" key={el.id}>
                <h3>{el.title}</h3>
                <LiveStatus election={el} now={now} showBar={false} />
                {voted && <p className="small">You’ve already voted here — your receipt is saved.</p>}
                <button className="primary" onClick={() => setSelected(el.id)}>
                  {voted ? "View receipt / results" : "Open ballot"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

function ElectionVoter({ election, onBack }) {
  const { state, dispatch, go } = useApp();
  const now = useNow();
  const st = getStatus(election, now);
  const me = state.session;
  const tally = useTally(election);
  const [tab, setTab] = useState("vote");
  const [choice, setChoice] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [castErr, setCastErr] = useState("");
  const receipt = election.voted[me.id];
  const eid = election.id;

  // if the window closes (or is paused) while the confirm dialog is up, dismiss it
  useEffect(() => { if (st.key !== "open") setConfirm(false); }, [st.key]);

  async function cast() {
    if (getStatus(election, Date.now()).key !== "open") {
      setConfirm(false);
      setCastErr("Voting is no longer open, so your vote was not recorded.");
      return;
    }
    setCastErr("");
    const r = await makeReceipt(me.id, choice);
    dispatch({ type: "CAST_VOTE", electionId: eid, voterId: me.id, cid: choice, receipt: r });
    setConfirm(false);
  }

  return (
    <main className="content">
      <button className="ghost" onClick={onBack}>← All elections</button>
      <h1>{election.title}</h1>
      <LiveStatus election={election} now={now} />
      <Tabs tabs={[["vote", "My ballot"], ["results", "Results"]]} tab={tab} setTab={setTab} />
      {castErr && <p className="error" role="alert">{castErr}</p>}

      {tab === "vote" && (receipt ? (
        <div className="receipt">
          <h2>Your vote is recorded</h2>
          <p>Keep this receipt code to confirm your ballot was counted. You can check it anytime on the Verify receipt page.</p>
          <code>{receipt}</code>
        </div>
      ) : st.key !== "open" ? (
        <p className="notice">{st.key === "upcoming" ? `Voting opens ${fmt(election.schedule.start)}.` : st.key === "closed" ? "Voting has closed. You can’t vote now." : st.key === "paused" ? "The admin has paused voting. Check back soon." : "The admin hasn’t scheduled this election yet."}</p>
      ) : election.candidates.length === 0 ? (
        <p className="notice">No candidates have been registered yet.</p>
      ) : (
        <>
          <h2>Cast your vote</h2>
          <p className="sub">Pick one candidate. You can’t change your vote after confirming.</p>
          <div className="ballot">
            {election.candidates.map((c) => (
              <label key={c.id} className={"cand" + (choice === c.id ? " picked" : "")}>
                <input type="radio" name="cand" checked={choice === c.id} onChange={() => setChoice(c.id)} />
                <span className="mark" aria-hidden="true" />
                <span className="info"><strong>{c.name}</strong><em>{c.party}</em><span>{c.pledge}</span></span>
              </label>
            ))}
          </div>
          <button className="primary" disabled={!choice} onClick={() => setConfirm(true)}>Review my vote</button>
        </>
      ))}

      {tab === "results" && (election.announced ? (
        <>
          <h2>Official results</h2>
          <WinnerBanner tally={tally} />
          <p className="sub">{tally.total} votes cast</p>
          <ResultBars tally={tally} />
          <button className="ghost" onClick={() => go("results", election.id)}>Open on results page</button>
        </>
      ) : <p className="notice">Results haven’t been announced yet. The admin will publish them after voting closes.</p>)}

      {confirm && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>Confirm your vote</h3>
            <p>You are voting for <strong>{election.candidates.find((c) => c.id === choice)?.name}</strong>. This can’t be undone.</p>
            <div className="row"><button className="ghost" onClick={() => setConfirm(false)}>Go back</button><button className="primary" onClick={cast}>Confirm vote</button></div>
          </div>
        </div>
      )}
    </main>
  );
}

/* ---------- admin panel (election switcher + per-election admin) ---------- */
function AdminPanel() {
  const { state, dispatch } = useApp();
  const elections = Object.values(state.elections);
  const activeId = state.activeElectionId;
  const election = state.elections[activeId];
  const [newTitle, setNewTitle] = useState("");

  function createElection(e) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    dispatch({ type: "ADD_ELECTION", title: newTitle.trim() });
    setNewTitle("");
  }
  function deleteElection() {
    if (window.confirm(`Delete "${election.title}" and all its candidates, votes and schedule? This can’t be undone.`)) {
      dispatch({ type: "REMOVE_ELECTION", id: activeId });
    }
  }

  return (
    <main className="content wide">
      <h1>Admin panel</h1>

      <div className="election-switch">
        {elections.length > 0 && (
          <label>Managing election
            <select value={activeId || ""} onChange={(e) => dispatch({ type: "SET_ACTIVE_ELECTION", id: e.target.value })}>
              {elections.map((el) => <option key={el.id} value={el.id}>{el.title}</option>)}
            </select>
          </label>
        )}
        <form className="inline-form small-form" onSubmit={createElection}>
          <input placeholder="New election name" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          <button className="secondary" type="submit">Create election</button>
        </form>
        {election && <button className="ghost danger" onClick={deleteElection}>Delete this election</button>}
      </div>

      {!election ? (
        <p className="notice">Create an election above to get started.</p>
      ) : (
        <ElectionAdmin key={election.id} election={election} />
      )}
    </main>
  );
}

function ElectionAdmin({ election }) {
  const { state, dispatch } = useApp();
  const now = useNow();
  const st = getStatus(election, now);
  const tally = useTally(election);
  const [tab, setTab] = useState("overview");
  const [cand, setCand] = useState({ name: "", party: "", pledge: "" });
  const [candErr, setCandErr] = useState("");
  const [sched, setSched] = useState({ start: toLocalInput(election.schedule.start), end: toLocalInput(election.schedule.end) });
  const [schedMsg, setSchedMsg] = useState("");
  const voterList = Object.entries(state.voters);
  const turnout = voterList.length ? Math.round((tally.total / voterList.length) * 100) : 0;
  const canAnnounce = st.key === "closed" || st.key === "paused";
  const eid = election.id;

  function addCand(e) {
    e.preventDefault();
    if (!cand.name.trim() || !cand.party.trim()) return setCandErr("Enter the candidate’s name and party.");
    if (election.candidates.some((c) => c.name.toLowerCase() === cand.name.trim().toLowerCase())) return setCandErr("A candidate with this name already exists.");
    dispatch({ type: "ADD_CAND", electionId: eid, cand: { name: cand.name.trim(), party: cand.party.trim(), pledge: cand.pledge.trim() } });
    setCand({ name: "", party: "", pledge: "" }); setCandErr("");
  }
  function saveSchedule(e) {
    e.preventDefault();
    const start = new Date(sched.start).getTime(), end = new Date(sched.end).getTime();
    if (!start || !end) return setSchedMsg("Choose both a start and an end.");
    if (end <= start) return setSchedMsg("The end must be after the start.");
    dispatch({ type: "SET_SCHEDULE", electionId: eid, schedule: { start, end } });
    setSchedMsg("Schedule saved.");
  }

  return (
    <>
      <h2 className="election-heading">{election.title}</h2>
      <Tabs tabs={[["overview", "Overview"], ["candidates", "Candidates"], ["schedule", "Schedule"], ["voters", "Voters"], ["results", "Results"]]} tab={tab} setTab={setTab} />

      {tab === "overview" && (
        <>
          <div className="stats">
            <div><b>{election.candidates.length}</b><span>Candidates registered</span></div>
            <div><b>{voterList.length}</b><span>Registered voters</span></div>
            <div><b>{tally.total}</b><span>Votes cast</span></div>
            <div><b>{turnout}%</b><span>Turnout</span></div>
          </div>
          <LiveStatus election={election} now={now} />
          <div className="row left">
            <button className="secondary" onClick={() => dispatch({ type: "TOGGLE_SUSPEND", electionId: eid })}>{election.suspended ? "Resume voting" : "Pause voting"}</button>
            <button className="ghost danger" onClick={() => { if (window.confirm("Clear all votes and un-announce results? Candidates and voters stay.")) dispatch({ type: "RESET_ELECTION", electionId: eid }); }}>Reset election</button>
          </div>
        </>
      )}

      {tab === "candidates" && (
        <>
          <h2>{election.candidates.length} candidates</h2>
          <form className="inline-form" onSubmit={addCand}>
            <input placeholder="Name" value={cand.name} onChange={(e) => setCand({ ...cand, name: e.target.value })} />
            <input placeholder="Party" value={cand.party} onChange={(e) => setCand({ ...cand, party: e.target.value })} />
            <input placeholder="Pledge (optional)" value={cand.pledge} onChange={(e) => setCand({ ...cand, pledge: e.target.value })} />
            <button className="primary" type="submit">Add candidate</button>
          </form>
          {candErr && <p className="error">{candErr}</p>}
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Party</th><th>Pledge</th><th>Votes</th><th></th></tr></thead>
            <tbody>
              {election.candidates.map((c) => (
                <tr key={c.id}><td>{c.name}</td><td>{c.party}</td><td>{c.pledge}</td><td>{election.votes[c.id] || 0}</td>
                  <td><button className="ghost danger" disabled={tally.total > 0} title={tally.total > 0 ? "Reset the election to remove candidates" : ""} onClick={() => dispatch({ type: "REMOVE_CAND", electionId: eid, id: c.id })}>Remove</button></td></tr>
              ))}
            </tbody>
          </table></div>
          {tally.total > 0 && <p className="small">Candidates can’t be removed once voting has started.</p>}
        </>
      )}

      {tab === "schedule" && (
        <form className="panel schedule" onSubmit={saveSchedule}>
          <h2>Voting dates and time</h2>
          <label>Voting starts<input type="datetime-local" value={sched.start} onChange={(e) => setSched({ ...sched, start: e.target.value })} /></label>
          <label>Voting ends<input type="datetime-local" value={sched.end} onChange={(e) => setSched({ ...sched, end: e.target.value })} /></label>
          {schedMsg && <p className={schedMsg === "Schedule saved." ? "ok" : "error"}>{schedMsg}</p>}
          <button className="primary" type="submit">Save schedule</button>
          <p className="small">Current: {fmt(election.schedule.start)} to {fmt(election.schedule.end)}</p>
        </form>
      )}

      {tab === "voters" && (
        <>
          <h2>{voterList.length} registered voters</h2>
          <p className="small">Voters are shared across every election — this list isn’t election-specific.</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Voter ID</th><th>Phone</th><th>Voted here</th></tr></thead>
            <tbody>{voterList.map(([id, v]) => (<tr key={id}><td>{v.name}</td><td>{id}</td><td>{v.phone}</td><td>{election.voted[id] ? "Yes" : "No"}</td></tr>))}</tbody>
          </table></div>
        </>
      )}

      {tab === "results" && (
        <>
          <h2>Live tally</h2>
          <p className="sub">{tally.total} votes · visible only to you until you announce.</p>
          <ResultBars tally={tally} />
          {election.announced && <WinnerBanner tally={tally} />}
          <div className="row left">
            {election.announced ? (
              <button className="secondary" onClick={() => dispatch({ type: "ANNOUNCE", electionId: eid, value: false })}>Withdraw announcement</button>
            ) : (
              <button className="primary" disabled={!canAnnounce} onClick={() => dispatch({ type: "ANNOUNCE", electionId: eid, value: true })}>Announce results</button>
            )}
          </div>
          {!canAnnounce && !election.announced && <p className="small">You can announce once voting has closed or been paused.</p>}
        </>
      )}
    </>
  );
}