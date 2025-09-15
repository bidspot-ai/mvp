// --- 0. GLOBAL STATE AND CONFIGURATION ---
let periodCounter = 0;
let pinnedDemandRequests = [];
let floatingDemandRequests = [];
let requestIdCounter = 0;
let lastAllocationPlan = null;
let priceHistory = {};
let chartInstances = {};

// Configurations will be loaded from YAML
let WORKLOAD_CONFIG = {};
let CLUSTER_CONFIG = {};
let TEAMS_CONFIG = {};

// Dynamic state for teams
let teamsState = {};

async function loadConfigs() {
    const clusterYamlString = `
    us-east-1:
      total_machines: 128
      guaranteed_machines: 30
      base_guaranteed: 1.00
      base_spot: 0.20
      sensitivity_g: 2.0
      sensitivity_s: 1.2
    eu-west-2:
      total_machines: 64
      guaranteed_machines: 40
      base_guaranteed: 1.10
      base_spot: 0.22
      sensitivity_g: 2.2
      sensitivity_s: 1.3
    ap-northeast-1:
      total_machines: 256
      guaranteed_machines: 10
      base_guaranteed: 0.90
      base_spot: 0.18
      sensitivity_g: 1.8
      sensitivity_s: 1.1
    `;
    CLUSTER_CONFIG = jsyaml.load(clusterYamlString);

    const workloadYamlString = `
    inference:
      gpus: 1
      name: 'AI Inference'
      minDurationPeriods: 1
      maxDurationPeriods: 6
    training_batch:
      gpus: 4
      name: 'Training Batch'
      minDurationPeriods: 2
      maxDurationPeriods: 24
    large_training:
      gpus: 8
      name: 'Large Training'
      minDurationPeriods: 12
      maxDurationPeriods: 240
    `;
    WORKLOAD_CONFIG = jsyaml.load(workloadYamlString);

    const teamsYamlString = `
    product_research:
      name: "Product Research"
      budget: 1000000
      color: "blue"
    production_platform:
      name: "Production Platform"
      budget: 1200000
      color: "green"
    sales:
      name: "Sales & Marketing"
      budget: 800000
      color: "purple"
    `;
    TEAMS_CONFIG = jsyaml.load(teamsYamlString);
}

function initializeTeamsState() {
    teamsState = {};
    for (const teamId in TEAMS_CONFIG) {
        teamsState[teamId] = {
            budget: TEAMS_CONFIG[teamId].budget,
            stats: {
                totalSpent: 0,
                jobsRun: 0,
            },
            completedJobs: []
        };
    }
}

let machineState = {}; // Tracks jobs on each machine
let completedJobs = []; // Global history of completed jobs

function initializeMachineState() {
    machineState = {};
    for (const clusterId in CLUSTER_CONFIG) {
        const config = CLUSTER_CONFIG[clusterId];
        machineState[clusterId] = [];
        const spotMachines = config.total_machines - config.guaranteed_machines;
        for (let i = 0; i < spotMachines; i++) {
            machineState[clusterId].push({ jobs: [], availableGpus: 8 });
        }
    }
}

// --- DOM ELEMENTS ---
const periodCounterEl = document.getElementById('period-counter');
const runAlgorithmBtn = document.getElementById('run-algorithm-btn');
const addPinnedBtn = document.getElementById('add-pinned-btn');
const addFloatingBtn = document.getElementById('add-floating-btn');
const demandQueueDisplay = document.getElementById('demand-queue-display');
const clusterStateDisplay = document.getElementById('cluster-state-display');
const priceListDisplay = document.getElementById('price-list-display');
const allocationPlanDisplay = document.getElementById('allocation-plan-display');
const priceChartsGrid = document.getElementById('price-charts-grid');
const teamDashboardsDisplay = document.getElementById('team-dashboards-display');

// --- 1. CORE ALGORITHM FUNCTIONS ---

function calculateGuaranteedPrice(clusterId) {
    const config = CLUSTER_CONFIG[clusterId];
    const utilization = config.guaranteed_machines / config.total_machines;
    const adjustmentFactor = Math.pow(1 + utilization, config.sensitivity_g);
    return (config.base_guaranteed * 8) * adjustmentFactor;
}

function calculateSpotPricePerGPU(clusterId, currentGpuUsage) {
    const config = CLUSTER_CONFIG[clusterId];
    const spotSupply = (config.total_machines - config.guaranteed_machines) * 8;
    if (spotSupply <= 0) return Infinity;
    const demand = currentGpuUsage > 0 ? currentGpuUsage : 1;
    const ratio = demand / spotSupply;
    const adjustmentFactor = Math.pow(ratio, config.sensitivity_s);
    let finalPrice = config.base_spot * adjustmentFactor;
    const priceFloor = config.base_spot * 0.5;
    const priceCeiling = config.base_spot * 10.0;
    return Math.max(priceFloor, Math.min(priceCeiling, finalPrice));
}

function findAndAllocate(clusterId, shape, teamId, duration, cost, state) {
    const gpusNeeded = WORKLOAD_CONFIG[shape].gpus;
    const machines = state[clusterId];
    for (let i = 0; i < machines.length; i++) {
        if (machines[i].availableGpus >= gpusNeeded) {
            machines[i].jobs.push({
                gpus: gpusNeeded,
                shape: shape,
                teamId: teamId,
                cost: cost,
                completionPeriod: periodCounter + duration,
                startPeriod: periodCounter,
                duration: duration
            });
            machines[i].availableGpus -= gpusNeeded;
            return true;
        }
    }
    return false;
}

function canFit(clusterId, shape, state) {
    const gpusNeeded = WORKLOAD_CONFIG[shape].gpus;
    return state[clusterId].some(machine => machine.availableGpus >= gpusNeeded);
}

function runMarketClearingPeriod() {
    periodCounter++;

    for (const clusterId in machineState) {
        machineState[clusterId].forEach(machine => {
            const remainingJobs = [];
            machine.jobs.forEach(job => {
                if (job.completionPeriod > periodCounter) {
                    remainingJobs.push(job);
                } else {
                    completedJobs.push(job); 
                }
            });
            machine.jobs = remainingJobs;
            const gpusInUse = machine.jobs.reduce((acc, job) => acc + job.gpus, 0);
            machine.availableGpus = 8 - gpusInUse;
        });
    }

    const price_list = { guaranteed_prices: {}, spot_prices: {} };
    const allocation_plan = { satisfied_demand: { pinned: [], floating: [] }, unsatisfied_demand: { pinned: [], floating: [] } };
    const currentMachineState = JSON.parse(JSON.stringify(machineState));
    
    const currentGpuUsage = {};
    Object.keys(CLUSTER_CONFIG).forEach(id => {
        currentGpuUsage[id] = machineState[id].reduce((sum, machine) => sum + (8 - machine.availableGpus), 0);
    });

    for (const clusterId in CLUSTER_CONFIG) {
        price_list.guaranteed_prices[clusterId] = calculateGuaranteedPrice(clusterId);
    }

    const processRequest = (req, isPinned) => {
        const teamBudget = teamsState[req.teamId].budget;
        const gpusForShape = WORKLOAD_CONFIG[req.shape].gpus;
        const shapeConfig = WORKLOAD_CONFIG[req.shape];
        const duration = Math.floor(shapeConfig.minDurationPeriods + Math.random() * (shapeConfig.maxDurationPeriods - shapeConfig.minDurationPeriods + 1));
        
        let cheapestOption = { cluster: null, cost: Infinity };

        const targetClusters = isPinned ? [req.cluster] : Object.keys(CLUSTER_CONFIG);

        for (const clusterId of targetClusters) {
            if (canFit(clusterId, req.shape, currentMachineState)) {
                const pricePerGpu = calculateSpotPricePerGPU(clusterId, currentGpuUsage[clusterId] + gpusForShape);
                const totalCost = pricePerGpu * gpusForShape * duration;

                if (totalCost < cheapestOption.cost && teamBudget >= totalCost) {
                    cheapestOption = { cluster: clusterId, cost: totalCost };
                }
            }
        }

        if (cheapestOption.cluster) {
            findAndAllocate(cheapestOption.cluster, req.shape, req.teamId, duration, cheapestOption.cost, currentMachineState);
            teamsState[req.teamId].budget -= cheapestOption.cost;
            teamsState[req.teamId].stats.totalSpent += cheapestOption.cost;
            teamsState[req.teamId].stats.jobsRun++;
            currentGpuUsage[cheapestOption.cluster] += gpusForShape;

            const jobDetails = { ...req, cost: cheapestOption.cost, cluster: cheapestOption.cluster, duration };
            const list = isPinned ? allocation_plan.satisfied_demand.pinned : allocation_plan.satisfied_demand.floating;
            list.push(jobDetails);
            return true;
        }
        return false;
    };

    pinnedDemandRequests.forEach(req => {
        let satisfiedCount = 0;
        for (let i = 0; i < req.quantity; i++) {
            if (processRequest(req, true)) satisfiedCount++;
        }
        if (req.quantity - satisfiedCount > 0) allocation_plan.unsatisfied_demand.pinned.push({...req, unsatisfied_quantity: req.quantity - satisfiedCount});
    });

    floatingDemandRequests.forEach(req => {
        let satisfiedCount = 0;
        for (let i = 0; i < req.quantity; i++) {
            if (processRequest(req, false)) satisfiedCount++;
        }
        if (req.quantity - satisfiedCount > 0) allocation_plan.unsatisfied_demand.floating.push({...req, unsatisfied_quantity: req.quantity - satisfiedCount});
    });

    for (const clusterId in CLUSTER_CONFIG) {
        price_list.spot_prices[clusterId] = calculateSpotPricePerGPU(clusterId, currentGpuUsage[clusterId]);
    }

    updatePriceCharts(price_list.spot_prices);
    machineState = currentMachineState;
    lastAllocationPlan = allocation_plan;

    renderAll(price_list, allocation_plan);
    recordClusterOutputsYaml(price_list, allocation_plan);
    pinnedDemandRequests = [];
    floatingDemandRequests = [];
    renderDemandQueue();
    // --- YAML OUTPUT FOR CLUSTERS (Download Only) ---
    function recordClusterOutputsYaml(priceList, allocationPlan) {
        const output = {};
        for (const clusterId in CLUSTER_CONFIG) {
            output[clusterId] = {
                guaranteed_price: priceList.guaranteed_prices[clusterId],
                spot_price: priceList.spot_prices[clusterId],
                satisfied_pinned: allocationPlan.satisfied_demand.pinned.filter(r => r.cluster === clusterId),
                satisfied_floating: allocationPlan.satisfied_demand.floating.filter(r => r.cluster === clusterId),
                unsatisfied_pinned: allocationPlan.unsatisfied_demand.pinned.filter(r => r.cluster === clusterId),
                unsatisfied_floating: allocationPlan.unsatisfied_demand.floating.filter(r => r.cluster === clusterId)
            };
        }
        const yamlStr = jsyaml.dump(output, { noRefs: true, lineWidth: 120 });
        offerYamlDownload(yamlStr);
    }

    function offerYamlDownload(yamlStr) {
        let dlBtn = document.getElementById('yaml-download-btn');
        if (!dlBtn) {
            dlBtn = document.createElement('button');
            dlBtn.id = 'yaml-download-btn';
            dlBtn.className = 'btn btn-primary';
            dlBtn.textContent = 'Download YAML Output';
            dlBtn.style.marginTop = '2em';
            document.body.appendChild(dlBtn);
            dlBtn.addEventListener('click', () => {
                const blob = new Blob([yamlStr], { type: 'text/yaml' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `cluster_output_period_${periodCounter}.yaml`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
            });

            // Add button to open cluster_scheduler.html with YAML as URL param (base64 encoded)
            let openSchedulerBtn = document.getElementById('open-scheduler-btn');
            if (!openSchedulerBtn) {
                openSchedulerBtn = document.createElement('button');
                openSchedulerBtn.id = 'open-scheduler-btn';
                openSchedulerBtn.className = 'btn btn-secondary';
                openSchedulerBtn.textContent = 'Open in Cluster Scheduler';
                openSchedulerBtn.style.marginLeft = '1em';
                dlBtn.parentNode.insertBefore(openSchedulerBtn, dlBtn.nextSibling);
                openSchedulerBtn.addEventListener('click', () => {
                    // base64 encode and URI encode the YAML
                    const b64 = btoa(unescape(encodeURIComponent(yamlStr)));
                    const url = `cluster_scheduler.html?yaml=${encodeURIComponent(b64)}`;
                    window.open(url, '_blank');
                });
            }
        }
    }
}
function displayYamlOutput(yamlStr) {
    let yamlOutputEl = document.getElementById('yaml-output');
    if (!yamlOutputEl) {
        yamlOutputEl = document.createElement('pre');
        yamlOutputEl.id = 'yaml-output';
        yamlOutputEl.style.background = '#f3f4f6';
        yamlOutputEl.style.border = '1px solid #e5e7eb';
        yamlOutputEl.style.padding = '1em';
        yamlOutputEl.style.marginTop = '2em';
        yamlOutputEl.style.overflowX = 'auto';
        yamlOutputEl.style.maxHeight = '300px';
        yamlOutputEl.style.fontSize = '0.95em';
        yamlOutputEl.style.whiteSpace = 'pre-wrap';
        document.body.appendChild(yamlOutputEl);
    }
    yamlOutputEl.textContent = yamlStr;
    // Optionally, add a download button
    let dlBtn = document.getElementById('yaml-download-btn');
    if (!dlBtn) {
        dlBtn = document.createElement('button');
        dlBtn.id = 'yaml-download-btn';
        dlBtn.className = 'btn btn-primary';
        dlBtn.textContent = 'Download YAML Output';
        dlBtn.style.marginLeft = '1em';
        yamlOutputEl.parentNode.insertBefore(dlBtn, yamlOutputEl.nextSibling);
        dlBtn.addEventListener('click', () => {
            const blob = new Blob([yamlStr], { type: 'text/yaml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cluster_output_period_${periodCounter}.yaml`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        });
    }
}

// --- 2. UI RENDERING & CHART FUNCTIONS ---

function populateDropdowns() {
    const pinnedShapeSelect = document.getElementById('pinned-workload-shape');
    const floatingShapeSelect = document.getElementById('floating-workload-shape');
    const teamSelect = document.getElementById('team-selector');
    const clusterSelect = document.getElementById('pinned-cluster');

    pinnedShapeSelect.innerHTML = '';
    floatingShapeSelect.innerHTML = '';
    teamSelect.innerHTML = '';
    clusterSelect.innerHTML = '';

    for (const shapeId in WORKLOAD_CONFIG) {
        const shape = WORKLOAD_CONFIG[shapeId];
        const optionText = `${shape.name} (${shape.gpus} GPU${shape.gpus > 1 ? 's' : ''})`;
        pinnedShapeSelect.innerHTML += `<option value="${shapeId}">${optionText}</option>`;
        floatingShapeSelect.innerHTML += `<option value="${shapeId}">${optionText}</option>`;
    }

    for (const teamId in TEAMS_CONFIG) {
        teamSelect.innerHTML += `<option value="${teamId}">${TEAMS_CONFIG[teamId].name}</option>`;
    }
    
    for (const clusterId in CLUSTER_CONFIG) {
        clusterSelect.innerHTML += `<option value="${clusterId}">to ${clusterId}</option>`;
    }
}

function initializePriceCharts() {
    priceChartsGrid.innerHTML = '';
    chartInstances = {};
    priceHistory = {};

    const colors = {
        "us-east-1": 'rgba(75, 192, 192, 1)',
        "eu-west-2": 'rgba(255, 99, 132, 1)',
        "ap-northeast-1": 'rgba(255, 206, 86, 1)'
    };
    const bgColors = {
        "us-east-1": 'rgba(75, 192, 192, 0.2)',
        "eu-west-2": 'rgba(255, 99, 132, 0.2)',
        "ap-northeast-1": 'rgba(255, 206, 86, 0.2)'
    };

    for (const clusterId in CLUSTER_CONFIG) {
        priceHistory[clusterId] = [];
        const canvasContainer = document.createElement('div');
        const canvasEl = document.createElement('canvas');
        canvasContainer.innerHTML = `<h4 class="text-center font-medium text-gray-700">${clusterId}</h4>`;
        canvasContainer.appendChild(canvasEl);
        priceChartsGrid.appendChild(canvasContainer);
        const ctx = canvasEl.getContext('2d');
        chartInstances[clusterId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: `Spot Price`,
                    data: [],
                    borderColor: colors[clusterId] || 'rgba(54, 162, 235, 1)',
                    backgroundColor: bgColors[clusterId] || 'rgba(54, 162, 235, 0.2)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.1
                }]
            },
            options: {
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { callback: value => value.toFixed(4) }
                    }
                },
                plugins: { legend: { display: false } }
            }
        });
    }
}

function updatePriceCharts(newPrices) {
    for (const clusterId in newPrices) {
        if (chartInstances[clusterId]) {
            const chart = chartInstances[clusterId];
            priceHistory[clusterId].push(newPrices[clusterId]);
            chart.data.labels.push(`P${periodCounter}`);
            chart.data.datasets[0].data.push(newPrices[clusterId]);
            if (chart.data.labels.length > 10) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
            }
            chart.update();
        }
    }
}

function renderPeriodCounter() { periodCounterEl.textContent = periodCounter; }

function renderDemandQueue() {
    demandQueueDisplay.innerHTML = '';
    if (pinnedDemandRequests.length === 0 && floatingDemandRequests.length === 0) {
        demandQueueDisplay.innerHTML = `<p class="text-gray-500">No requests.</p>`;
        return;
    }
    const renderReq = (req, type) => {
        const shapeName = WORKLOAD_CONFIG[req.shape].name;
        const teamName = TEAMS_CONFIG[req.teamId].name;
        const color = type === 'Pinned' ? 'indigo' : 'emerald';
        const target = type === 'Pinned' ? ` to <strong>${req.cluster}</strong>` : '';
        demandQueueDisplay.innerHTML += `<div class="p-2 bg-${color}-50 rounded-md"><strong>${teamName} (${type}):</strong> ${req.quantity}x ${shapeName}${target}</div>`;
    };
    pinnedDemandRequests.forEach(req => renderReq(req, 'Pinned'));
    floatingDemandRequests.forEach(req => renderReq(req, 'Floating'));
}

function renderClusterState() {
    clusterStateDisplay.innerHTML = '';
    for (const clusterId in CLUSTER_CONFIG) {
        const config = CLUSTER_CONFIG[clusterId];
        const machines = machineState[clusterId];
        if (!machines) continue;

        const totalGpus = (config.total_machines - config.guaranteed_machines) * 8;
        const availableGpus = machines.reduce((acc, machine) => acc + machine.availableGpus, 0);

        const availableSlots = {
            large_training: machines.filter(m => m.availableGpus >= 8).length,
            training_batch: machines.filter(m => m.availableGpus >= 4).length,
            inference: machines.reduce((sum, m) => sum + Math.floor(m.availableGpus / 1), 0)
        };
        
        const el = document.createElement('a');
        el.className = 'p-4 bg-gray-100 rounded-lg space-y-2 border block hover:shadow-lg hover:border-indigo-500 transition-all cursor-pointer';
        el.target = '_blank';

        let demandForScheduler = [];
        if (lastAllocationPlan) {
            const satisfied = lastAllocationPlan.satisfied_demand;
            satisfied.pinned.concat(satisfied.floating).forEach(req => {
                if (req.cluster === clusterId) {
                     const existing = demandForScheduler.find(d => d.shape === req.shape);
                    if (existing) { existing.quantity++; } 
                    else { demandForScheduler.push({ shape: req.shape, quantity: 1 }); }
                }
            });
        }
        
        const schedulerConfig = { numMachines: config.total_machines - config.guaranteed_machines };
        el.href = `cluster_scheduler.html?clusterId=${clusterId}&config=${encodeURIComponent(JSON.stringify(schedulerConfig))}&demand=${encodeURIComponent(JSON.stringify(demandForScheduler))}`;

        el.innerHTML = `
            <h4 class="font-bold text-lg">${clusterId}</h4>
            <div>Total Spot GPUs: <span class="font-medium">${totalGpus}</span></div>
            <div class="font-semibold text-blue-600">Available GPUs: <span class="font-bold">${availableGpus} / ${totalGpus}</span></div>
            <hr class="my-2">
            <div class="text-xs">
                <div>Large Training (8) Slots: <span class="font-bold text-red-600">${availableSlots.large_training}</span></div>
                <div>Training Batch (4) Slots: <span class="font-bold text-yellow-600">${availableSlots.training_batch}</span></div>
                <div>AI Inference (1) Slots: <span class="font-bold text-green-600">${availableSlots.inference}</span></div>
            </div>
        `;
        clusterStateDisplay.appendChild(el);
    }
}

function renderPriceList(priceList) {
    priceListDisplay.innerHTML = '';
    priceListDisplay.innerHTML += '<h4 class="font-semibold text-gray-700">Guaranteed Prices (per 8-GPU Machine)</h4>';
    for(const clusterId in priceList.guaranteed_prices){
        priceListDisplay.innerHTML += `<div class="text-sm">${clusterId}: <span class="font-bold text-indigo-600">${priceList.guaranteed_prices[clusterId].toFixed(2)} BSC</span></div>`;
    }
    priceListDisplay.innerHTML += '<h4 class="font-semibold text-gray-700 mt-3">Spot Prices (per GPU)</h4>';
     for(const clusterId in priceList.spot_prices){
        const price = isFinite(priceList.spot_prices[clusterId]) ? `${priceList.spot_prices[clusterId].toFixed(4)} BSC` : 'Unavailable';
        priceListDisplay.innerHTML += `<div class="text-sm">${clusterId}: <span class="font-bold text-emerald-600">${price}</span></div>`;
    }
}

function renderAllocationPlan(plan){
    allocationPlanDisplay.innerHTML = '';
    allocationPlanDisplay.innerHTML += '<h4 class="font-semibold text-green-700">Satisfied Demand</h4>';
    if (plan.satisfied_demand.pinned.length === 0 && plan.satisfied_demand.floating.length === 0) {
        allocationPlanDisplay.innerHTML += `<p class="text-sm text-gray-500">None</p>`;
    } else {
        const renderSatisfied = (req) => {
            const teamName = TEAMS_CONFIG[req.teamId].name;
            const shapeName = WORKLOAD_CONFIG[req.shape].name;
            const cost = req.cost.toFixed(0);
            const cluster = req.cluster;
            allocationPlanDisplay.innerHTML += `<div class="text-xs p-1 bg-green-50 rounded"><strong>${teamName}:</strong> 1x ${shapeName} on <strong>${cluster}</strong> for ${cost} BSC</div>`;
        };
        plan.satisfied_demand.pinned.forEach(renderSatisfied);
        plan.satisfied_demand.floating.forEach(renderSatisfied);
    }

    allocationPlanDisplay.innerHTML += '<h4 class="font-semibold text-red-700 mt-4">Unsatisfied Demand</h4>';
    if (plan.unsatisfied_demand.pinned.length === 0 && plan.unsatisfied_demand.floating.length === 0) {
        allocationPlanDisplay.innerHTML += `<p class="text-sm text-gray-500">None</p>`;
    } else {
         const renderUnsatisfied = (req) => {
            const teamName = TEAMS_CONFIG[req.teamId].name;
            const shapeName = WORKLOAD_CONFIG[req.shape].name;
            allocationPlanDisplay.innerHTML += `<div class="text-xs p-1 bg-red-50 rounded"><strong>${teamName}:</strong> ${req.unsatisfied_quantity}x ${shapeName} (insufficient budget or capacity)</div>`;
        };
        plan.unsatisfied_demand.pinned.forEach(renderUnsatisfied);
        plan.unsatisfied_demand.floating.forEach(renderUnsatisfied);
    }
}

function renderTeamDashboards() {
    teamDashboardsDisplay.innerHTML = '';
    for (const teamId in teamsState) {
        const teamState = teamsState[teamId];
        const teamConfig = TEAMS_CONFIG[teamId];

        const runningJobs = [];
        for (const clusterId in machineState) {
            machineState[clusterId].forEach(machine => {
                machine.jobs.forEach(job => {
                    if (job.teamId === teamId) {
                        runningJobs.push({...job, clusterId});
                    }
                });
            });
        }
        
        const teamCompletedJobs = completedJobs.filter(j => j.teamId === teamId);

        const cardLink = document.createElement('a');
        cardLink.className = `card space-y-2 block hover:shadow-lg hover:border-${teamConfig.color}-500 transition-all cursor-pointer`;
        
        const dataForDashboard = {
            teamId,
            teamConfig,
            teamState: { // Only pass serializable data
                budget: teamState.budget,
                stats: teamState.stats
            },
            runningJobs,
            completedJobs: teamCompletedJobs.slice(-20), // Limit history for URL length
            workloadConfig: WORKLOAD_CONFIG
        };
        const encodedData = encodeURIComponent(JSON.stringify(dataForDashboard));
        cardLink.href = `team_dashboard.html?data=${encodedData}`;
        cardLink.target = '_blank';

        cardLink.innerHTML = `
            <h3 class="text-xl font-bold text-${teamConfig.color}-600 flex justify-between items-center">
                <span>${teamConfig.name}</span>
                <span class="text-xs font-normal bg-gray-200 text-gray-700 px-2 py-1 rounded-full">View Detailed Dashboard &rarr;</span>
            </h3>
            <div>
                <span class="font-semibold">Budget:</span> 
                <span class="font-bold text-green-600">${Math.floor(teamState.budget).toLocaleString()} BSC</span>
            </div>
            <div class="text-sm">
                <p><strong>Running Jobs:</strong> ${runningJobs.length}</p>
            </div>
        `;
        teamDashboardsDisplay.appendChild(cardLink);
    }
}


function renderAll(priceList, allocationPlan) {
    renderPeriodCounter();
    renderClusterState();
    renderPriceList(priceList);
    renderAllocationPlan(allocationPlan);
    renderTeamDashboards();
}


// --- 3. EVENT LISTENERS ---
addPinnedBtn.addEventListener('click', () => {
    const teamId = document.getElementById('team-selector').value;
    const cluster = document.getElementById('pinned-cluster').value;
    const shape = document.getElementById('pinned-workload-shape').value;
    const quantity = parseInt(document.getElementById('pinned-quantity').value, 10);
    if (quantity > 0) {
        requestIdCounter++;
        pinnedDemandRequests.push({ id: requestIdCounter, teamId, cluster, shape, quantity });
        renderDemandQueue();
    }
});

addFloatingBtn.addEventListener('click', () => {
    const teamId = document.getElementById('team-selector').value;
    const shape = document.getElementById('floating-workload-shape').value;
    const quantity = parseInt(document.getElementById('floating-quantity').value, 10);
    if (quantity > 0) {
        requestIdCounter++;
        floatingDemandRequests.push({ id: requestIdCounter, teamId, shape, quantity });
        renderDemandQueue();
    }
});

runAlgorithmBtn.addEventListener('click', runMarketClearingPeriod);

// --- PERIODIC TICK FOR MARKET CLEARING ---
let clearingIntervalId = null;
const TICK_PERIOD_MS = 3000; // 3 seconds per period

// Add a button to start/stop the periodic clearing
const autoTickBtn = document.createElement('button');
autoTickBtn.id = 'auto-tick-btn';
autoTickBtn.className = 'btn btn-secondary w-full md:w-auto shadow-lg flex items-center justify-center gap-2';
autoTickBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clip-rule="evenodd" />
    </svg>
    <span>Start Auto-Tick</span>`;
runAlgorithmBtn.parentNode.insertBefore(autoTickBtn, runAlgorithmBtn.nextSibling);


function startMarketAutoTick() {
    if (!clearingIntervalId) {
        clearingIntervalId = setInterval(runMarketClearingPeriod, TICK_PERIOD_MS);
        autoTickBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v4a1 1 0 11-2 0V8z" clip-rule="evenodd" />
            </svg>
            <span>Pause Auto-Tick</span>`;
    }
}

function stopMarketAutoTick() {
    if (clearingIntervalId) {
        clearInterval(clearingIntervalId);
        clearingIntervalId = null;
        autoTickBtn.innerHTML = `
             <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clip-rule="evenodd" />
            </svg>
            <span>Resume Auto-Tick</span>`;
    }
}

autoTickBtn.addEventListener('click', () => {
    if (clearingIntervalId) {
        stopMarketAutoTick();
    } else {
        startMarketAutoTick();
    }
});


// --- 4. INITIAL RENDER ---
window.addEventListener('DOMContentLoaded', async () => {
    await loadConfigs();
    initializeTeamsState();
    populateDropdowns();
    initializeMachineState();
    initializePriceCharts();
    renderPeriodCounter();
    renderDemandQueue();
    renderClusterState();
    renderTeamDashboards();
});
