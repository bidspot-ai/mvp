// app.js - Frontend demo logic for BidSpot MVP
// No backend required for demo; wires UI and simulates auctions/jobs.
// Replace simulated functions with real API calls later.

(() => {
  // ---------- Demo data ----------
  const teams = [
    { id: "team-a", name: "Vision Lab", credits: 1200, weight: 1.5 },
    { id: "team-b", name: "Search AI", credits: 780, weight: 1.1 },
    { id: "team-c", name: "Data Platform", credits: 540, weight: 0.8 },
    { id: "team-d", name: "Prod ML", credits: 3000, weight: 2.2 }
  ];

  let jobs = [
    { id: 1, name: "Train ResNet", team: "Vision Lab", gpus: 8, bid: 0.8, duration: 120, status: "queued", submittedAt: new Date() },
    { id: 2, name: "Batch Inference", team: "Search AI", gpus: 4, bid: 0.6, duration: 60, status: "queued", submittedAt: new Date() },
    { id: 3, name: "Hyperparam Scan", team: "Data Platform", gpus: 16, bid: 0.75, duration: 240, status: "queued", submittedAt: new Date() }
  ];

  // Auction history
  const history = [];

  // System snapshot
  const TOTAL_GPUS = 128;
  let allocatedGPUs = 0;

  // Auction cadence (seconds) - demo using 60s for faster feel, original doc uses 5 min.
  const CADENCE = 60;
  let countdownSec = CADENCE;

  // Sparkline / price history
  const priceHistory = [];
  let currentSpot = 0.45;

  // ---------- DOM references ----------
  const tabs = document.querySelectorAll(".nav-btn");
  const panels = document.querySelectorAll(".panel");
  const countdownEl = document.getElementById("countdown");
  const clearingPriceEl = document.getElementById("clearingPrice");
  const spotPriceEl = document.getElementById("spotPrice");
  const utilEl = document.getElementById("util");
  const auctionHistoryEl = document.getElementById("auctionHistory");
  const topBiddersEl = document.getElementById("topBidders");
  const jobQueueEl = document.getElementById("jobQueue");
  const jobsTableEl = document.getElementById("jobsTable");
  const teamsGridEl = document.getElementById("teamsGrid");
  const totalCreditsEl = document.getElementById("totalCredits");
  const burnRateEl = document.getElementById("burnRate");
  const efficiencyEl = document.getElementById("efficiency");
  const avgWaitEl = document.getElementById("avgWait");
  const savingsEl = document.getElementById("savings");
  const allocatedEl = document.getElementById("allocated");
  const freeEl = document.getElementById("free");

  // Modal
  const modal = document.getElementById("modal");
  const newJobBtn = document.getElementById("newJobBtn");
  const closeModal = document.getElementById("closeModal");
  const cancelModal = document.getElementById("cancelModal");
  const jobForm = document.getElementById("jobForm");
  const teamSelect = jobForm.elements["team"];

  // Sparkline canvas
  const ctx = document.getElementById("sparkline").getContext("2d");

  // ---------- UI wiring ----------

  // Tabs
  tabs.forEach(btn => btn.addEventListener("click", (e) => {
    tabs.forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    const t = btn.dataset.tab;
    panels.forEach(p => p.classList.toggle("active-panel", p.id === t));
  }));

  // Modal open/close
  newJobBtn.addEventListener("click", () => openModal());
  closeModal.addEventListener("click", closeModalFn);
  cancelModal.addEventListener("click", closeModalFn);
  function openModal(){
    populateTeamOptions();
    modal.classList.remove("hidden");
  }
  function closeModalFn(){
    modal.classList.add("hidden");
    jobForm.reset();
  }

  // Submit job
  jobForm.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const form = new FormData(jobForm);
    const job = {
      id: Date.now(),
      name: form.get("name"),
      team: form.get("team"),
      gpus: Number(form.get("gpus")),
      bid: Number(form.get("bid")),
      duration: Number(form.get("duration")),
      status: "queued",
      submittedAt: new Date()
    };
    jobs.push(job);
    closeModalFn();
    renderAll();
  });

  // Run Auction Now button
  document.getElementById("runNow").addEventListener("click", () => runAuction(true));

  // ---------- Helpers & rendering ----------
  function renderAll(){
    renderTopBidders();
    renderJobQueue();
    renderJobsTable();
    renderTeams();
    renderMetrics();
    drawSparkline();
  }

  function renderTopBidders(){
    // aggregate top bidders by current total bid weight in queue
    const sums = {};
    jobs.forEach(j => {
      if(!sums[j.team]) sums[j.team] = 0;
      sums[j.team] += j.bid * j.gpus;
    });
    const arr = Object.entries(sums).sort((a,b)=>b[1]-a[1]).slice(0,5);
    topBiddersEl.innerHTML = arr.map(([team, val]) => `<li><span>${team}</span><strong>$${val.toFixed(2)}</strong></li>`).join("");
    if(arr.length===0) topBiddersEl.innerHTML = "<li class='muted'>No active bidders</li>";
  }

  function renderJobQueue(){
    jobQueueEl.innerHTML = "";
    jobs.slice(0,8).forEach(j => {
      const li = document.createElement("li");
      li.className = "job-card";
      li.innerHTML = `
        <div class="job-meta">
          <div>
            <div style="font-weight:700">${j.name}</div>
            <div class="muted small">${j.team} · ${j.gpus} GPU · ${j.duration}m</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:800">$${j.bid.toFixed(2)}/min</div>
          <div class="muted small">${j.status}</div>
        </div>
      `;
      jobQueueEl.appendChild(li);
    });
    if(jobs.length===0) jobQueueEl.innerHTML = "<li class='muted'>Queue empty</li>";
  }

  function renderJobsTable(){
    jobsTableEl.innerHTML = jobs.map(j => `<tr>
      <td>${j.name}</td>
      <td>${j.team}</td>
      <td>${j.gpus}</td>
      <td>$${j.bid.toFixed(2)}</td>
      <td>${j.duration}m</td>
      <td>${j.status}</td>
    </tr>`).join("");
  }

  function renderTeams(){
    teamsGridEl.innerHTML = teams.map(t => `
      <div class="team-tile">
        <div class="team-name">${t.name}</div>
        <div class="team-credits">$${t.credits.toFixed(2)}</div>
        <div class="muted small">Weight ${t.weight}</div>
      </div>
    `).join("");
  }

  function renderMetrics(){
    const totalCredits = teams.reduce((s,t)=>s+t.credits,0);
    totalCreditsEl.textContent = `$${totalCredits.toFixed(2)}`;
    // Burn rate: sum of (bid * gpus) for running jobs; in demo, assume queued will consume at some rate
    const burn = jobs.reduce((s,j)=>s + (j.bid * j.gpus * 60 / 60),0); // $/hr rough
    burnRateEl.textContent = `$${burn.toFixed(2)}/hr`;
    // Efficiency, Wait time, Savings (dummy computed)
    const eff = Math.max(30, Math.min(92, 70 + (Math.random()*12 - 6)));
    efficiencyEl.textContent = `${Math.round(eff)}%`;
    const wait = Math.round((jobs.length*3)+Math.random()*10);
    avgWaitEl.textContent = `${wait}m`;
    savingsEl.textContent = `$${Math.round((eff/100)*1500)}`;
    allocatedEl.textContent = allocatedGPUs;
    freeEl.textContent = TOTAL_GPUS - allocatedGPUs;
  }

  function populateTeamOptions(){
    teamSelect.innerHTML = teams.map(t => `<option value="${t.name}">${t.name}</option>`).join("");
  }

  // ---------- Auction simulation ----------
  function tickCountdown(){
    countdownSec--;
    if(countdownSec < 0) {
      runAuction();
      countdownSec = CADENCE;
    }
    const mm = String(Math.floor(countdownSec/60)).padStart(2,'0');
    const ss = String(countdownSec%60).padStart(2,'0');
    countdownEl.textContent = `${mm}:${ss}`;
  }

  function runAuction(force = false){
    // Collect bids from queued jobs -> pick winners by highest bid per GPU until capacity
    // MVP: uniform-price auction: winners pay clearing price (bid of last accepted).
    if(jobs.length === 0){
      pushHistory(0,0,"—");
      return;
    }

    // prepare bid items
    const bidItems = [];
    jobs.forEach(job => {
      // treat all queued jobs as bidding for now
      if(job.status === "queued"){
        bidItems.push({
          job,
          key: job.id,
          price: job.bid,
          gpus: job.gpus
        });
      }
    });

    // sort descending by price
    bidItems.sort((a,b)=>b.price - a.price);

    let remaining = TOTAL_GPUS;
    let accepted = [];
    for (let item of bidItems) {
      if(item.gpus <= remaining){
        accepted.push(item);
        remaining -= item.gpus;
      } else {
        // partial allocation logic (not in MVP) — skip if not fit
      }
      if(remaining <= 0) break;
    }

    // Clearing price is the lowest accepted bid or spot baseline
    const clearingPrice = accepted.length ? Math.max(0.01, accepted[accepted.length-1].price) : 0;
    // mark accepted jobs as running (for demo)
    accepted.forEach(a => {
      a.job.status = "running";
      allocatedGPUs += a.gpus;
    });

    // compute spot price: weighted average + some noise
    currentSpot = (accepted.reduce((s,a)=>s + a.price*a.gpus,0) / Math.max(1, accepted.reduce((s,a)=>s + a.gpus,0))) || (0.4 + Math.random()*0.3);
    priceHistory.push(currentSpot);
    if(priceHistory.length>40) priceHistory.shift();

    // push to history
    pushHistory(clearingPrice, accepted.reduce((s,a)=>s+a.gpus,0), accepted.length ? accepted[0].job.team : "—");

    // if force-run, reset countdown to full cadence for cleaner UX
    if(force) countdownSec = CADENCE;

    // simulate time: running jobs decrement duration and may finish
    simulateTimePassage();

    renderAll();
    clearingPriceEl.textContent = `$${clearingPrice.toFixed(2)}`;
    spotPriceEl.textContent = `$${currentSpot.toFixed(2)}`;
    utilEl.textContent = `${Math.round((allocatedGPUs / TOTAL_GPUS) * 100)}%`;
  }

  function pushHistory(price, gpus, top){
    history.unshift({time: new Date(), price, gpus, top});
    if(history.length > 12) history.pop();
    auctionHistoryEl.innerHTML = history.map(h => `<tr>
      <td>${h.time.toLocaleTimeString()}</td>
      <td>$${h.price.toFixed(2)}</td>
      <td>${h.gpus}</td>
      <td>${h.top}</td>
    </tr>`).join("");
  }

  function simulateTimePassage(){
    // Each auction cycle reduces running job durations slightly; when done, free resources.
    const running = jobs.filter(j => j.status === "running");
    running.forEach(j => {
      // reduce by fraction of auction cadence; for demo, reduce some minutes
      j.duration -= Math.round(CADENCE / 30);
      if(j.duration <= 0){
        // finish job
        j.status = "done";
        allocatedGPUs -= j.gpus;
      }
    });
    // remove done jobs after a short retention
    jobs = jobs.filter(j => !(j.status === "done"));
  }

  // ---------- Sparkline drawing ----------
  function drawSparkline(){
    const c = ctx.canvas;
    ctx.clearRect(0,0,c.width,c.height);

    // background grid
    ctx.fillStyle = "rgba(255,255,255,0.01)";
    ctx.fillRect(0,0,c.width,c.height);

    if(priceHistory.length === 0){
      // draw baseline
      ctx.beginPath();
      ctx.moveTo(0, c.height/2);
      ctx.lineTo(c.width, c.height/2);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.stroke();
      return;
    }

    // normalize
    const vals = priceHistory.slice(-40);
    const max = Math.max(...vals) * 1.15;
    const min = Math.min(...vals) * 0.85;
    const range = Math.max(0.0001, max - min);
    ctx.beginPath();
    vals.forEach((v,i)=>{
      const x = (i / (vals.length-1 || 1)) * c.width;
      const y = c.height - ((v - min) / range) * c.height;
      if(i===0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    });
    // gradient stroke
    const grad = ctx.createLinearGradient(0,0,c.width,0);
    grad.addColorStop(0, '#6C5CE7');
    grad.addColorStop(1, '#00B4D8');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // fill under curve
    ctx.lineTo(c.width, c.height);
    ctx.lineTo(0, c.height);
    ctx.closePath();
    ctx.fillStyle = "rgba(108,92,231,0.08)";
    ctx.fill();
  }

  // ---------- Initialization ----------
  function init(){
    // seed price history
    for(let i=0;i<12;i++) priceHistory.push(0.35 + Math.random()*0.5);
    renderAll();
    // start auction timer
    setInterval(tickCountdown, 1000);
    // for demo, run auction automatically every CADENCE seconds
    setInterval(() => runAuction(false), CADENCE*1000 + 2000);
    // manual draw ticking
    setInterval(() => {
      drawSparkline();
      // light animation: nudge spot price occasionally
      spotPriceEl.textContent = `$${currentSpot.toFixed(2)}`;
    }, 2000);
    // immediate first render
    runAuction(true);
  }

  init();

})();
