// --- 0. GLOBAL STATE AND CONFIGURATION ---
let periodCounter = 0;
let pinnedDemandRequests = [];
let floatingDemandRequests = [];
let requestIdCounter = 0;
let lastAllocationPlan = null; // To hold the results for linking
let priceHistory = {};
let chartInstances = {};

// Configurations will be loaded from YAML below
let WORKLOAD_CONFIG = {};
let CLUSTER_CONFIG = {};

async function loadConfigs() {
    const clusterYamlString=`
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

    const workloadYamlString=`
    inference:
      gpus: 1
      name: 'AI Inference'
      minDurationPeriods: 1  # 30m
      maxDurationPeriods: 6  # 3h
    training_batch:
      gpus: 4
      name: 'Training Batch'
      minDurationPeriods: 2  # 1h
      maxDurationPeriods: 24 # 12h
    large_training:
      gpus: 8
      name: 'Large Training'
      minDurationPeriods: 12 # 6h
      maxDurationPeriods: 240 # 5d
    `;
    WORKLOAD_CONFIG = jsyaml.load(workloadYamlString);
}

// machineState now tracks individual jobs and their completion times
let machineState = {};

function initializeMachineState() {
    machineState = {};
    for (const clusterId in CLUSTER_CONFIG) {
        const config = CLUSTER_CONFIG[clusterId];
        machineState[clusterId] = [];
        // Only spot-available machines are tracked for allocation
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

// --- 1. CORE ALGORITHM FUNCTIONS ---

function calculateGuaranteedPrice(clusterId) {
    const config = CLUSTER_CONFIG[clusterId];
    const utilization = config.guaranteed_machines / config.total_machines;
    const adjustmentFactor = Math.pow(1 + utilization, config.sensitivity_g);
    // Price here is for a full 8-GPU machine reservation
    return (config.base_guaranteed * 8) * adjustmentFactor;
}

function calculateSpotPricePerGPU(clusterId, allocatedGpus) {
    const config = CLUSTER_CONFIG[clusterId];
    const spotMachines = config.total_machines - config.guaranteed_machines;
    if (spotMachines <= 0) return Infinity;

    const availableSpotSupply = spotMachines * 8;
    if (availableSpotSupply <= 0) return Infinity;

    let demand = allocatedGpus > 0 ? allocatedGpus : 1; // Use allocated GPUs, but ensure demand is at least 1 to avoid zero prices

    const ratio = demand / availableSpotSupply;
    const adjustmentFactor = Math.pow(ratio, config.sensitivity_s);
    let finalPrice = config.base_spot * adjustmentFactor;
    
    const priceFloor = config.base_spot * 0.5;
    const priceCeiling = config.base_spot * 10.0;
    finalPrice = Math.max(priceFloor, Math.min(priceCeiling, finalPrice));

    return finalPrice;
}

// Helper to find and allocate a job on a machine, now with duration
function findAndAllocate(clusterId, shape, state) {
    const gpusNeeded = WORKLOAD_CONFIG[shape].gpus;
    const machines = state[clusterId];
    for (let i = 0; i < machines.length; i++) {
        if (machines[i].availableGpus >= gpusNeeded) {
            // Found a spot, now calculate duration
            const shapeConfig = WORKLOAD_CONFIG[shape];
            const duration = Math.floor(shapeConfig.minDurationPeriods + Math.random() * (shapeConfig.maxDurationPeriods - shapeConfig.minDurationPeriods + 1));
            
            // Add the new job with its completion time
            machines[i].jobs.push({
                gpus: gpusNeeded,
                completionPeriod: periodCounter + duration
            });
            
            // Update available GPUs on this machine
            machines[i].availableGpus -= gpusNeeded;
            
            return true; // Success
        }
    }
    return false; // Failure
}

// Helper to just check if a shape can fit
 function canFit(clusterId, shape, state) {
    const gpusNeeded = WORKLOAD_CONFIG[shape].gpus;
    return state[clusterId].some(machine => machine.availableGpus >= gpusNeeded);
}


function runMarketClearingPeriod() {
    periodCounter++;

    // --- NEW: Step 1: Release completed jobs from machines ---
    for (const clusterId in machineState) {
        machineState[clusterId].forEach(machine => {
            // Filter out completed jobs (jobs whose completion period is in the past)
            machine.jobs = machine.jobs.filter(job => job.completionPeriod > periodCounter);
            // Recalculate available GPUs based on remaining jobs
            const gpusInUse = machine.jobs.reduce((acc, job) => acc + job.gpus, 0);
            machine.availableGpus = 8 - gpusInUse;
        });
    }

    // --- Step 2: Run the market clearing for the new demand ---
    const price_list = { guaranteed_prices: {}, spot_prices: {} };
    const allocation_plan = {
        satisfied_demand: { pinned: [], floating: [] },
        unsatisfied_demand: { pinned: [], floating: [] }
    };

    // Deep copy machine state for this period's simulation, as it's already updated with released jobs
    const currentMachineState = JSON.parse(JSON.stringify(machineState));
    const allocatedGpusPerCluster = {};
    Object.keys(CLUSTER_CONFIG).forEach(id => {
        const gpusInUse = machineState[id].reduce((sum, machine) => sum + (8 - machine.availableGpus), 0);
        allocatedGpusPerCluster[id] = gpusInUse;
    });

    for (const clusterId in CLUSTER_CONFIG) {
        price_list.guaranteed_prices[clusterId] = calculateGuaranteedPrice(clusterId);
    }

    // A. Handle Pinned Demand
    pinnedDemandRequests.forEach(req => {
        let satisfiedCount = 0;
        for (let i = 0; i < req.quantity; i++) {
            if (findAndAllocate(req.cluster, req.shape, currentMachineState)) {
                satisfiedCount++;
                allocatedGpusPerCluster[req.cluster] += WORKLOAD_CONFIG[req.shape].gpus;
            }
        }
        if (satisfiedCount > 0) {
             allocation_plan.satisfied_demand.pinned.push({...req, satisfied_quantity: satisfiedCount});
        }
        if (satisfiedCount < req.quantity) {
            allocation_plan.unsatisfied_demand.pinned.push({...req, unsatisfied_quantity: req.quantity - satisfiedCount});
        }
    });

    // B. Allocate Floating Demand
    const allFloatingJobs = [];
    floatingDemandRequests.forEach(req => {
        for(let i=0; i < req.quantity; i++){
            allFloatingJobs.push({ ...req, quantity: 1, original_id: req.id });
        }
    });

    allFloatingJobs.forEach(job => {
        let cheapestOption = { cluster: null, price: Infinity };

        for (const clusterId in CLUSTER_CONFIG) {
            if (canFit(clusterId, job.shape, currentMachineState)) {
                const gpusForShape = WORKLOAD_CONFIG[job.shape].gpus;
                // Predict price if we add this job
                const potentialPrice = calculateSpotPricePerGPU(clusterId, allocatedGpusPerCluster[clusterId] + gpusForShape) * gpusForShape;
                if (potentialPrice < cheapestOption.price) {
                    cheapestOption = { cluster: clusterId, price: potentialPrice };
                }
            }
        }

        if (cheapestOption.cluster) {
            const clusterId = cheapestOption.cluster;
            findAndAllocate(clusterId, job.shape, currentMachineState);
            allocatedGpusPerCluster[clusterId] += WORKLOAD_CONFIG[job.shape].gpus;

            let existing = allocation_plan.satisfied_demand.floating.find(r => r.id === job.original_id);
            if (!existing) {
                existing = { ...job, id: job.original_id, satisfied_quantity: 0, allocations: {} };
                allocation_plan.satisfied_demand.floating.push(existing);
            }
            existing.satisfied_quantity++;
            existing.allocations[clusterId] = (existing.allocations[clusterId] || 0) + 1;
        } else {
             let existing = allocation_plan.unsatisfied_demand.floating.find(r => r.id === job.original_id);
             if (!existing) {
                existing = { ...job, id: job.original_id, unsatisfied_quantity: 0 };
                allocation_plan.unsatisfied_demand.floating.push(existing);
             }
             existing.unsatisfied_quantity++;
        }
    });

    // C. Finalize Spot Prices
    for (const clusterId in CLUSTER_CONFIG) {
        price_list.spot_prices[clusterId] = calculateSpotPricePerGPU(clusterId, allocatedGpusPerCluster[clusterId]);
    }
    
    // Update charts with the new prices
    updatePriceCharts(price_list.spot_prices, price_list.guaranteed_prices);
    
    // Update the persistent machine state and save the allocation plan for linking
    machineState = currentMachineState;
    lastAllocationPlan = allocation_plan;

    // Render all UI components
    renderPeriodCounter();
    renderClusterState();
    renderPriceList(price_list);
    renderAllocationPlan(allocation_plan);

    // Clear the demand queue for the next period
    pinnedDemandRequests = [];
    floatingDemandRequests = [];
    renderDemandQueue();
}

// --- 2. UI RENDERING & CHART FUNCTIONS ---

function populateWorkloadDropdowns() {
    const pinnedSelect = document.getElementById('pinned-workload-shape');
    const floatingSelect = document.getElementById('floating-workload-shape');
    pinnedSelect.innerHTML = '';
    floatingSelect.innerHTML = '';

    for (const shapeId in WORKLOAD_CONFIG) {
        const shape = WORKLOAD_CONFIG[shapeId];
        const optionText = `${shape.name} (${shape.gpus} GPU${shape.gpus > 1 ? 's' : ''})`;
        
        const pinnedOption = document.createElement('option');
        pinnedOption.value = shapeId;
        pinnedOption.textContent = optionText;
        pinnedSelect.appendChild(pinnedOption);

        const floatingOption = document.createElement('option');
        floatingOption.value = shapeId;
        floatingOption.textContent = optionText;
        floatingSelect.appendChild(floatingOption);
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
        priceHistory[clusterId] = { spot: [], guaranteed: [] };
        const canvasContainer = document.createElement('div');
        canvasContainer.style.marginBottom = '24px';

        // Title
        canvasContainer.innerHTML = `<h4 class="text-center font-medium text-gray-700">${clusterId}</h4>`;

        // Spot price chart
        const spotCanvas = document.createElement('canvas');
        spotCanvas.style.marginBottom = '8px';
        canvasContainer.appendChild(spotCanvas);

        // Guaranteed price chart
        const guaranteedCanvas = document.createElement('canvas');
        canvasContainer.appendChild(guaranteedCanvas);

        priceChartsGrid.appendChild(canvasContainer);

        // Spot price chart
        const spotCtx = spotCanvas.getContext('2d');
        chartInstances[clusterId] = chartInstances[clusterId] || {};
        chartInstances[clusterId].spot = new Chart(spotCtx, {
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
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { callback: value => '$' + value.toFixed(4) }
                    }
                }
            }
        });

        // Guaranteed price chart
        const guaranteedCtx = guaranteedCanvas.getContext('2d');
        chartInstances[clusterId].guaranteed = new Chart(guaranteedCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: `Guaranteed Price`,
                    data: [],
                    borderColor: 'rgba(99, 102, 241, 1)', // Indigo
                    backgroundColor: 'rgba(99, 102, 241, 0.15)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.1
                }]
            },
            options: {
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { callback: value => '$' + value.toFixed(2) }
                    }
                }
            }
        });
    }
}

function updatePriceCharts(newSpotPrices, newGuaranteedPrices) {
    for (const clusterId in chartInstances) {
        // Update spot price history and chart
        if (chartInstances[clusterId].spot) {
            priceHistory[clusterId].spot.push(newSpotPrices[clusterId]);
            const spotChart = chartInstances[clusterId].spot;
            spotChart.data.labels.push(`P${periodCounter}`);
            spotChart.data.datasets[0].data.push(newSpotPrices[clusterId]);
            if (spotChart.data.labels.length > 10) {
                spotChart.data.labels.shift();
                spotChart.data.datasets[0].data.shift();
            }
            spotChart.update();
        }
        // Update guaranteed price history and chart
        if (chartInstances[clusterId].guaranteed) {
            priceHistory[clusterId].guaranteed.push(newGuaranteedPrices[clusterId]);
            const guaranteedChart = chartInstances[clusterId].guaranteed;
            guaranteedChart.data.labels.push(`P${periodCounter}`);
            guaranteedChart.data.datasets[0].data.push(newGuaranteedPrices[clusterId]);
            if (guaranteedChart.data.labels.length > 10) {
                guaranteedChart.data.labels.shift();
                guaranteedChart.data.datasets[0].data.shift();
            }
            guaranteedChart.update();
        }
    }
}

function renderPeriodCounter() { periodCounterEl.textContent = periodCounter; }

function renderDemandQueue() {
    demandQueueDisplay.innerHTML = '';
    if (pinnedDemandRequests.length === 0 && floatingDemandRequests.length === 0) {
        demandQueueDisplay.innerHTML = `<p class="text-gray-500">No requests added yet.</p>`;
        return;
    }
    const renderReq = (req, type) => {
        const shapeName = WORKLOAD_CONFIG[req.shape].name;
        const color = type === 'Pinned' ? 'indigo' : 'emerald';
        const target = type === 'Pinned' ? ` to <strong>${req.cluster}</strong>` : '';
        demandQueueDisplay.innerHTML += `<div class="p-2 bg-${color}-50 rounded-md"><strong>${type}:</strong> ${req.quantity}x ${shapeName}${target} (ID: ${req.id})</div>`;
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

        // Prepare data for the scheduler link
        let demandForScheduler = [];
        if (lastAllocationPlan && lastAllocationPlan.satisfied_demand) {
            // Aggregate pinned demand for this cluster
            lastAllocationPlan.satisfied_demand.pinned.filter(req => req.cluster === clusterId).forEach(req => {
                const existing = demandForScheduler.find(d => d.shape === req.shape);
                if (existing) { existing.quantity += req.satisfied_quantity; } 
                else { demandForScheduler.push({ shape: req.shape, quantity: req.satisfied_quantity }); }
            });

            // Aggregate floating demand allocated to this cluster
            lastAllocationPlan.satisfied_demand.floating.forEach(req => {
                const allocatedQuantity = req.allocations[clusterId];
                if (allocatedQuantity > 0) {
                    const existing = demandForScheduler.find(d => d.shape === req.shape);
                    if (existing) { existing.quantity += allocatedQuantity; } 
                    else { demandForScheduler.push({ shape: req.shape, quantity: allocatedQuantity }); }
                }
            });
        }
        
        const schedulerConfig = { numMachines: config.total_machines - config.guaranteed_machines };
        const configParam = encodeURIComponent(JSON.stringify(schedulerConfig));
        const demandParam = encodeURIComponent(JSON.stringify(demandForScheduler));

        el.href = `cluster_scheduler.html?clusterId=${clusterId}&config=${configParam}&demand=${demandParam}`;

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
        priceListDisplay.innerHTML += `<div class="text-sm">${clusterId}: <span class="font-bold text-indigo-600">$${priceList.guaranteed_prices[clusterId].toFixed(2)}</span></div>`;
    }
    priceListDisplay.innerHTML += '<h4 class="font-semibold text-gray-700 mt-3">Spot Prices (per GPU)</h4>';
     for(const clusterId in priceList.spot_prices){
        const price = isFinite(priceList.spot_prices[clusterId]) ? `$${priceList.spot_prices[clusterId].toFixed(4)}` : 'Unavailable';
        priceListDisplay.innerHTML += `<div class="text-sm">${clusterId}: <span class="font-bold text-emerald-600">${price}</span></div>`;
    }
}

function renderAllocationPlan(plan){
    allocationPlanDisplay.innerHTML = '';
    allocationPlanDisplay.innerHTML += '<h4 class="font-semibold text-green-700">Satisfied Demand</h4>';
    if (plan.satisfied_demand.pinned.length === 0 && plan.satisfied_demand.floating.length === 0) {
        allocationPlanDisplay.innerHTML += `<p class="text-sm text-gray-500">None</p>`;
    } else {
        plan.satisfied_demand.pinned.forEach(req => {
            allocationPlanDisplay.innerHTML += `<div class="text-xs p-1 bg-green-50 rounded"><strong>Pinned #${req.id}:</strong> ${req.satisfied_quantity}/${req.quantity} jobs on <strong>${req.cluster}</strong></div>`;
        });
        plan.satisfied_demand.floating.forEach(req => {
            const allocs = Object.entries(req.allocations).map(([c, q]) => `${q} on <strong>${c}</strong>`).join(', ');
            allocationPlanDisplay.innerHTML += `<div class="text-xs p-1 bg-green-50 rounded"><strong>Floating #${req.id}:</strong> ${req.satisfied_quantity}/${req.quantity} jobs placed (${allocs})</div>`;
        });
    }

    allocationPlanDisplay.innerHTML += '<h4 class="font-semibold text-red-700 mt-4">Unsatisfied Demand</h4>';
    if (plan.unsatisfied_demand.pinned.length === 0 && plan.unsatisfied_demand.floating.length === 0) {
        allocationPlanDisplay.innerHTML += `<p class="text-sm text-gray-500">None</p>`;
    } else {
        plan.unsatisfied_demand.pinned.forEach(req => {
            allocationPlanDisplay.innerHTML += `<div class="text-xs p-1 bg-red-50 rounded"><strong>Pinned #${req.id}:</strong> ${req.unsatisfied_quantity} jobs for <strong>${req.cluster}</strong></div>`;
        });
        plan.unsatisfied_demand.floating.forEach(req => {
            allocationPlanDisplay.innerHTML += `<div class="text-xs p-1 bg-red-50 rounded"><strong>Floating #${req.id}:</strong> ${req.unsatisfied_quantity} jobs</div>`;
        });
    }
}

// --- 3. EVENT LISTENERS ---
addPinnedBtn.addEventListener('click', () => {
    const cluster = document.getElementById('pinned-cluster').value;
    const shape = document.getElementById('pinned-workload-shape').value;
    const quantity = parseInt(document.getElementById('pinned-quantity').value, 10);
    if (quantity > 0) {
        requestIdCounter++;
        pinnedDemandRequests.push({ id: requestIdCounter, cluster, shape, quantity });
        renderDemandQueue();
    }
});

addFloatingBtn.addEventListener('click', () => {
    const shape = document.getElementById('floating-workload-shape').value;
    const quantity = parseInt(document.getElementById('floating-quantity').value, 10);
    if (quantity > 0) {
        requestIdCounter++;
        floatingDemandRequests.push({ id: requestIdCounter, shape, quantity });
        renderDemandQueue();
    }
});

runAlgorithmBtn.addEventListener('click', runMarketClearingPeriod);

// --- 4. INITIAL RENDER ---
window.addEventListener('DOMContentLoaded', async () => {
    await loadConfigs();
    populateWorkloadDropdowns();
    initializeMachineState();
    initializePriceCharts();
    renderPeriodCounter();
    renderDemandQueue();
    renderClusterState();
});
