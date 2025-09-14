// --- 0. GLOBAL STATE AND CONFIGURATION ---
let periodCounter = 0;
let pinnedDemandRequests = [];
let floatingDemandRequests = [];
let requestIdCounter = 0;
let lastAllocationPlan = null; // To hold the results for linking

const WORKLOAD_SHAPES = {
    'inference': { gpus: 1, name: 'AI Inference' },
    'training_batch': { gpus: 4, name: 'Training Batch' },
    'large_training': { gpus: 8, name: 'Large Training' }
};

let CLUSTER_CONFIG = {};

async function loadClusterConfig() {
    const yamlString=`
    # Example cluster configuration
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
    CLUSTER_CONFIG = jsyaml.load(yamlString);
}

// This will hold the state of each machine's available GPUs
let machineState = {};

function initializeMachineState() {
    machineState = {};
    for (const clusterId in CLUSTER_CONFIG) {
        const config = CLUSTER_CONFIG[clusterId];
        machineState[clusterId] = [];
        // Only spot-available machines are tracked for allocation
        for (let i = 0; i < config.total_machines - config.guaranteed_machines; i++) {
            machineState[clusterId].push(8); // Each machine starts with 8 GPUs
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

    let demand = allocatedGpus;
    if (demand <= 0) demand = 1; // Prevent zero price

    const ratio = demand / availableSpotSupply;
    const adjustmentFactor = Math.pow(ratio, config.sensitivity_s);
    let finalPrice = config.base_spot * adjustmentFactor;
    
    const priceFloor = config.base_spot * 0.5;
    const priceCeiling = config.base_spot * 10.0;
    finalPrice = Math.max(priceFloor, Math.min(priceCeiling, finalPrice));

    return finalPrice;
}

// Helper to find and allocate a job on a machine
function findAndAllocate(clusterId, shape, state) {
    const gpusNeeded = WORKLOAD_SHAPES[shape].gpus;
    const machines = state[clusterId];
    for (let i = 0; i < machines.length; i++) {
        if (machines[i] >= gpusNeeded) {
            machines[i] -= gpusNeeded;
            return true; // Success
        }
    }
    return false; // Failure
}

// Helper to just check if a shape can fit
 function canFit(clusterId, shape, state) {
    const gpusNeeded = WORKLOAD_SHAPES[shape].gpus;
    return state[clusterId].some(gpus => gpus >= gpusNeeded);
}


function runMarketClearingPeriod() {
    periodCounter++;

    const price_list = { guaranteed_prices: {}, spot_prices: {} };
    const allocation_plan = {
        satisfied_demand: { pinned: [], floating: [] },
        unsatisfied_demand: { pinned: [], floating: [] }
    };

    // Deep copy machine state for this period's simulation
    const currentMachineState = JSON.parse(JSON.stringify(machineState));
    const allocatedGpusPerCluster = {};
    Object.keys(CLUSTER_CONFIG).forEach(id => allocatedGpusPerCluster[id] = 0);

    for (const clusterId in CLUSTER_CONFIG) {
        price_list.guaranteed_prices[clusterId] = calculateGuaranteedPrice(clusterId);
    }

    // A. Handle Pinned Demand
    pinnedDemandRequests.forEach(req => {
        let satisfiedCount = 0;
        for (let i = 0; i < req.quantity; i++) {
            if (findAndAllocate(req.cluster, req.shape, currentMachineState)) {
                satisfiedCount++;
                allocatedGpusPerCluster[req.cluster] += WORKLOAD_SHAPES[req.shape].gpus;
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
                const gpusForShape = WORKLOAD_SHAPES[job.shape].gpus;
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
            allocatedGpusPerCluster[clusterId] += WORKLOAD_SHAPES[job.shape].gpus;

            // Aggregate satisfied floating jobs
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
    
    // Update the persistent machine state for the next period
    machineState = currentMachineState;
    lastAllocationPlan = allocation_plan; // Store the plan for linking

    renderPeriodCounter();
    renderClusterState();
    renderPriceList(price_list);
    renderAllocationPlan(allocation_plan);

    pinnedDemandRequests = [];
    floatingDemandRequests = [];
    renderDemandQueue();
}

// --- 2. UI RENDERING FUNCTIONS ---
function renderPeriodCounter() { periodCounterEl.textContent = periodCounter; }

function renderDemandQueue() {
    demandQueueDisplay.innerHTML = '';
    if (pinnedDemandRequests.length === 0 && floatingDemandRequests.length === 0) {
        demandQueueDisplay.innerHTML = `<p class="text-gray-500">No requests added yet.</p>`;
        return;
    }
    const renderReq = (req, type) => {
        const el = document.createElement('div');
        const shapeName = WORKLOAD_SHAPES[req.shape].name;
        const color = type === 'Pinned' ? 'indigo' : 'emerald';
        el.className = `p-2 bg-${color}-50 rounded-md`;
        const target = type === 'Pinned' ? ` to <strong>${req.cluster}</strong>` : '';
        el.innerHTML = `<strong>${type}:</strong> ${req.quantity}x ${shapeName}${target} (ID: ${req.id})`;
        demandQueueDisplay.appendChild(el);
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
        const availableGpus = machines.reduce((a, b) => a + b, 0);

        const availableSlots = {
            large_training: machines.filter(g => g >= 8).length,
            training_batch: machines.filter(g => g >= 4).length,
            inference: machines.reduce((sum, gpus) => sum + Math.floor(gpus / 1), 0)
        };
        
        const el = document.createElement('a');
        el.className = 'p-4 bg-gray-100 rounded-lg space-y-2 border block hover:shadow-lg hover:border-indigo-500 transition-all cursor-pointer';
        el.target = '_blank';

        let demandForScheduler = [];
        if (lastAllocationPlan && lastAllocationPlan.satisfied_demand) {
            // Collect pinned demand for this cluster
            lastAllocationPlan.satisfied_demand.pinned
                .filter(req => req.cluster === clusterId)
                .forEach(req => {
                    const existing = demandForScheduler.find(d => d.shape === req.shape);
                    if (existing) {
                        existing.quantity += req.satisfied_quantity;
                    } else {
                        demandForScheduler.push({ shape: req.shape, quantity: req.satisfied_quantity });
                    }
                });

            // Collect floating demand allocated to this cluster
            lastAllocationPlan.satisfied_demand.floating.forEach(req => {
                const allocatedQuantity = req.allocations[clusterId];
                if (allocatedQuantity > 0) {
                    const existing = demandForScheduler.find(d => d.shape === req.shape);
                    if (existing) {
                        existing.quantity += allocatedQuantity;
                    } else {
                        demandForScheduler.push({ shape: req.shape, quantity: allocatedQuantity });
                    }
                }
            });
        }
        
        const schedulerConfig = { 
            numMachines: config.total_machines - config.guaranteed_machines 
        };

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
    const guaranteedEl = document.createElement('div');
    guaranteedEl.innerHTML = '<h4 class="font-semibold text-gray-700">Guaranteed Prices (per 8-GPU Machine)</h4>';
    const spotEl = document.createElement('div');
    spotEl.innerHTML = '<h4 class="font-semibold text-gray-700 mt-3">Spot Prices (per GPU)</h4>';

    for(const clusterId in priceList.guaranteed_prices){
        guaranteedEl.innerHTML += `<div class="text-sm">${clusterId}: <span class="font-bold text-indigo-600">$${priceList.guaranteed_prices[clusterId].toFixed(2)}</span></div>`;
    }
     for(const clusterId in priceList.spot_prices){
        const price = isFinite(priceList.spot_prices[clusterId]) ? `$${priceList.spot_prices[clusterId].toFixed(4)}` : 'Unavailable';
        spotEl.innerHTML += `<div class="text-sm">${clusterId}: <span class="font-bold text-emerald-600">${price}</span></div>`;
    }
    priceListDisplay.appendChild(guaranteedEl);
    priceListDisplay.appendChild(spotEl);
}

function renderAllocationPlan(plan){
    allocationPlanDisplay.innerHTML = '';
    const satisfiedEl = document.createElement('div');
    satisfiedEl.innerHTML = '<h4 class="font-semibold text-green-700">Satisfied Demand</h4>';
    if (plan.satisfied_demand.pinned.length === 0 && plan.satisfied_demand.floating.length === 0) {
        satisfiedEl.innerHTML += `<p class="text-sm text-gray-500">None</p>`;
    } else {
        plan.satisfied_demand.pinned.forEach(req => {
            satisfiedEl.innerHTML += `<div class="text-xs p-1 bg-green-50 rounded"><strong>Pinned #${req.id}:</strong> ${req.satisfied_quantity}/${req.quantity} jobs on <strong>${req.cluster}</strong></div>`;
        });
        plan.satisfied_demand.floating.forEach(req => {
            const allocs = Object.entries(req.allocations).map(([c, q]) => `${q} on <strong>${c}</strong>`).join(', ');
            satisfiedEl.innerHTML += `<div class="text-xs p-1 bg-green-50 rounded"><strong>Floating #${req.id}:</strong> ${req.satisfied_quantity}/${req.quantity} jobs placed (${allocs})</div>`;
        });
    }
    allocationPlanDisplay.appendChild(satisfiedEl);

    const unsatisfiedEl = document.createElement('div');
    unsatisfiedEl.innerHTML = '<h4 class="font-semibold text-red-700">Unsatisfied Demand</h4>';
    if (plan.unsatisfied_demand.pinned.length === 0 && plan.unsatisfied_demand.floating.length === 0) {
        unsatisfiedEl.innerHTML += `<p class="text-sm text-gray-500">None</p>`;
    } else {
        plan.unsatisfied_demand.pinned.forEach(req => {
            unsatisfiedEl.innerHTML += `<div class="text-xs p-1 bg-red-50 rounded"><strong>Pinned #${req.id}:</strong> ${req.unsatisfied_quantity} jobs for <strong>${req.cluster}</strong></div>`;
        });
        plan.unsatisfied_demand.floating.forEach(req => {
            unsatisfiedEl.innerHTML += `<div class="text-xs p-1 bg-red-50 rounded"><strong>Floating #${req.id}:</strong> ${req.unsatisfied_quantity} jobs</div>`;
        });
    }
    allocationPlanDisplay.appendChild(unsatisfiedEl);
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
    await loadClusterConfig();
    initializeMachineState();
    renderPeriodCounter();
    renderDemandQueue();
    renderClusterState();
});

