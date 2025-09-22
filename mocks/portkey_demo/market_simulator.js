// --- 0. GLOBAL STATE AND CONFIGURATION ---
let periodCounter = 0;
let demandRequests = [];
let requestIdCounter = 0;
let lastAllocationPlan = null;
let priceHistory = {};
let chartInstances = {};
let PORTKEY_API_KEY = '';

// Configurations for the LLM marketplace - will be populated from API
let LLM_MODELS_CONFIG = {};
let TEAMS_CONFIG = {};

// Dynamic state for teams
let teamsState = {};

async function loadStaticConfigs() {
    // Team configs can remain static for the demo
    const teamsYamlString = `
    product_research:
      name: "Product Research"
      budget: 10000
      color: "blue"
    production_platform:
      name: "Production Platform"
      budget: 12000
      color: "green"
    sales:
      name: "Sales & Marketing"
      budget: 8000
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
                requestsSent: 0,
            },
            completedRequests: []
        };
    }
}

// --- DOM ELEMENTS ---
const periodCounterEl = document.getElementById('period-counter');
const runAlgorithmBtn = document.getElementById('run-algorithm-btn');
const addDemandBtn = document.getElementById('add-demand-btn');
const demandQueueDisplay = document.getElementById('demand-queue-display');
const llmCostsDisplay = document.getElementById('llm-costs-display');
const priceListDisplay = document.getElementById('price-list-display');
const allocationPlanDisplay = document.getElementById('allocation-plan-display');
const priceChartsGrid = document.getElementById('price-charts-grid');
const teamDashboardsDisplay = document.getElementById('team-dashboards-display');
const portkeyApiKeyInput = document.getElementById('portkey-api-key');
const fetchModelsBtn = document.getElementById('fetch-models-btn');
const apiStatusEl = document.getElementById('api-status');

// --- 1. CORE ALGORITHM FUNCTIONS ---

/**
 * Fetches real-time LLM costs from the Portkey AI Gateway.
 */
async function fetchLLMCostsFromPortkey() {
    if (!PORTKEY_API_KEY) {
        apiStatusEl.textContent = 'Error: Portkey API Key is missing.';
        apiStatusEl.classList.add('text-red-500');
        return null;
    }

    apiStatusEl.textContent = 'Fetching live model data from Portkey...';
    apiStatusEl.classList.remove('text-red-500');

    try {
        const response = await fetch('https://api.portkey.ai/v1/models', {
            method: 'GET',
            headers: {
                'x-portkey-api-key': PORTKEY_API_KEY.trim(),
                'Content-Type': 'application/json'
            },
        });

        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();
        console.info('Portkey API response:', data);
        
        // Transform the Portkey response into our LLM_MODELS_CONFIG format
        const newConfig = {};
        const tiers = ['High-Performance', 'Balanced', 'Economical'];
        pro_count = 0;
        lite_count = 0;
        other_count = 0;
        data.data.forEach(model => {
            // Portkey gives cost per 1M tokens, we want per 1k
            if (!model.slug.includes('gemini')) return; // Demo focus on Gemini models
            if (model.slug.includes('preview')) return; // Skip preview models
            console.info('Processing model:', model.id, model.slug);
            inputCost1k = 0.0001;
            outputCost1k = 0.00005;
            if (model.slug.includes('pro')) {
                inputCost1k = 0.01;
                outputCost1k = 0.005;
                pro_count += 1;
                if (pro_count > 3) return;
            } else if (model.slug.includes('lite')) {
                inputCost1k = 0.003;
                outputCost1k = 0.0015;
                lite_count += 1;
                if (lite_count > 3) return;
            } else {
                other_count += 1;
                if (other_count > 3) return;
            }
            
            // Heuristic to assign a tier and color for the demo
            let tier = 'Economical';
            let color = 'teal';
            if (inputCost1k >= 0.01) {
                tier = 'High-Performance';
                color = 'purple';
            } else if (inputCost1k > 0.003) {
                tier = 'Balanced';
                color = 'blue';
            }

            newConfig[model.id] = {
                name: model.slug || model.canonical_slug,
                tier: tier,
                base_cost_input: inputCost1k,
                base_cost_output: outputCost1k,
                color: color
            };
        });

        LLM_MODELS_CONFIG = newConfig;
        apiStatusEl.textContent = `Successfully fetched ${Object.keys(LLM_MODELS_CONFIG).length} models. Ready to run simulation.`;
        apiStatusEl.classList.add('text-green-600');
        return fetchLiveCosts(); // Return a snapshot of live costs

    } catch (error) {
        console.error('Error fetching from Portkey:', error);
        apiStatusEl.textContent = `Error: Failed to fetch data. Check API key and console.`;
        apiStatusEl.classList.add('text-red-500');
        return null;
    }
}

// Simulates live fluctuations based on the fetched base costs
function fetchLiveCosts() {
    const liveCosts = {};
    for (const modelId in LLM_MODELS_CONFIG) {
        const model = LLM_MODELS_CONFIG[modelId];
        const fluctuation = 1 + (Math.random() - 0.5) * 0.05; // +/- 2.5% fluctuation
        liveCosts[modelId] = {
            input: model.base_cost_input * fluctuation,
            output: model.base_cost_output * fluctuation,
        };
    }
    return liveCosts;
}


function runMarketClearingPeriod() {
    periodCounter++;

    const liveCosts = fetchLiveCosts();
    
    const allocation_plan = { satisfied_demand: [], unsatisfied_demand: [] };

    demandRequests.forEach(req => {
        const teamBudget = teamsState[req.teamId].budget;
        const modelCost = liveCosts[req.modelId];
        
        const estimatedTokensPerRequest = { input: 1000, output: 500 }; 
        const costPerRequest = (modelCost.input * (estimatedTokensPerRequest.input / 1000)) + 
                               (modelCost.output * (estimatedTokensPerRequest.output / 1000));
        
        const totalCost = costPerRequest * req.quantity;

        if (teamBudget >= totalCost) {
            teamsState[req.teamId].budget -= totalCost;
            teamsState[req.teamId].stats.totalSpent += totalCost;
            teamsState[req.teamId].stats.requestsSent += req.quantity;
            
            const satisfiedReq = { ...req, cost: totalCost };
            allocation_plan.satisfied_demand.push(satisfiedReq);
            teamsState[req.teamId].completedRequests.push(satisfiedReq);
        } else {
            allocation_plan.unsatisfied_demand.push({ ...req, reason: 'Insufficient budget' });
        }
    });
    
    updatePriceCharts(liveCosts);
    lastAllocationPlan = allocation_plan;

    renderAll(liveCosts, allocation_plan);
    
    demandRequests = [];
    renderDemandQueue();
}

// --- 2. UI RENDERING & CHART FUNCTIONS ---

function populateDropdowns() {
    const llmModelSelect = document.getElementById('llm-model-selector');
    const teamSelect = document.getElementById('team-selector');

    llmModelSelect.innerHTML = '';
    teamSelect.innerHTML = '';

    if (Object.keys(LLM_MODELS_CONFIG).length === 0) {
        llmModelSelect.innerHTML = '<option>Fetch models first...</option>';
        llmModelSelect.disabled = true;
        addDemandBtn.disabled = true;
        runAlgorithmBtn.disabled = true;
    } else {
        for (const modelId in LLM_MODELS_CONFIG) {
            const model = LLM_MODELS_CONFIG[modelId];
            llmModelSelect.innerHTML += `<option value="${modelId}">${model.name} (${model.tier})</option>`;
        }
        llmModelSelect.disabled = false;
        addDemandBtn.disabled = false;
        runAlgorithmBtn.disabled = false;
    }


    for (const teamId in TEAMS_CONFIG) {
        teamSelect.innerHTML += `<option value="${teamId}">${TEAMS_CONFIG[teamId].name}</option>`;
    }
}

function initializePriceCharts() {
    priceChartsGrid.innerHTML = '';
    chartInstances = {};
    priceHistory = {};

    for (const modelId in LLM_MODELS_CONFIG) {
        priceHistory[modelId] = [];
        const canvasContainer = document.createElement('div');
        const canvasEl = document.createElement('canvas');
        canvasContainer.innerHTML = `<h4 class="text-center font-medium text-gray-700">${LLM_MODELS_CONFIG[modelId].name}</h4>`;
        canvasContainer.appendChild(canvasEl);
        priceChartsGrid.appendChild(canvasContainer);
        const ctx = canvasEl.getContext('2d');
        chartInstances[modelId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: `Cost/1k Tokens (Input)`,
                    data: [],
                    borderColor: LLM_MODELS_CONFIG[modelId].color || 'rgba(54, 162, 235, 1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.1
                }]
            },
            options: {
                scales: {
                    y: {
                        beginAtZero: false,
                        ticks: { callback: value => '$' + value.toFixed(5) }
                    }
                },
                plugins: { legend: { display: false } }
            }
        });
    }
}

function updatePriceCharts(newCosts) {
    for (const modelId in newCosts) {
        if (chartInstances[modelId]) {
            const chart = chartInstances[modelId];
            const inputCost = newCosts[modelId].input;
            priceHistory[modelId].push(inputCost);
            chart.data.labels.push(`P${periodCounter}`);
            chart.data.datasets[0].data.push(inputCost);
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
    if (demandRequests.length === 0) {
        demandQueueDisplay.innerHTML = `<p class="text-gray-500">No requests.</p>`;
        return;
    }
    demandRequests.forEach(req => {
        const modelName = LLM_MODELS_CONFIG[req.modelId]?.name || req.modelId;
        const teamName = TEAMS_CONFIG[req.teamId].name;
        const color = TEAMS_CONFIG[req.teamId].color;
        demandQueueDisplay.innerHTML += `<div class="p-2 bg-${color}-100 rounded-md"><strong>${teamName}:</strong> ${req.quantity.toLocaleString()} requests for <strong>${modelName}</strong></div>`;
    });
}

function renderLlmCosts(liveCosts) {
    llmCostsDisplay.innerHTML = '';
    if (!liveCosts || Object.keys(liveCosts).length === 0) {
        llmCostsDisplay.innerHTML = `<p class="text-gray-500 col-span-3">Waiting for live data from Portkey...</p>`;
        return;
    }
    for (const modelId in liveCosts) {
        const model = LLM_MODELS_CONFIG[modelId];
        const cost = liveCosts[modelId];
        const el = document.createElement('div');
        el.className = `p-4 bg-gray-100 rounded-lg space-y-2 border border-${model.color}-200`;
        el.innerHTML = `
            <h4 class="font-bold text-lg text-${model.color}-700">${model.name}</h4>
            <div class="text-xs">
                <div>Input: <span class="font-bold">${(cost.input).toFixed(5)}</span></div>
                <div>Output: <span class="font-bold">${(cost.output).toFixed(5)}</span></div>
            </div>
        `;
        llmCostsDisplay.appendChild(el);
    }
}

function renderPriceList(liveCosts) {
    priceListDisplay.innerHTML = '';
     if (!liveCosts || Object.keys(liveCosts).length === 0) {
        priceListDisplay.innerHTML = `<p class="text-gray-500">Fetch models to see prices.</p>`;
        return;
    }
    for(const modelId in liveCosts){
        const model = LLM_MODELS_CONFIG[modelId];
        const cost = liveCosts[modelId];
        priceListDisplay.innerHTML += `<div class="text-sm"><strong>${model.name}:</strong> 
            <span class="font-medium text-indigo-600">In: ${(cost.input).toFixed(5)}</span> | 
            <span class="font-medium text-emerald-600">Out: ${(cost.output).toFixed(5)}</span>
        </div>`;
    }
}

function renderAllocationPlan(plan){
    allocationPlanDisplay.innerHTML = '';
    allocationPlanDisplay.innerHTML += '<h4 class="font-semibold text-green-700">Satisfied Requests</h4>';
    if (!plan || plan.satisfied_demand.length === 0) {
        allocationPlanDisplay.innerHTML += `<p class="text-sm text-gray-500">None</p>`;
    } else {
        plan.satisfied_demand.forEach(req => {
            const teamName = TEAMS_CONFIG[req.teamId].name;
            const modelName = LLM_MODELS_CONFIG[req.modelId]?.name || req.modelId;
            const cost = req.cost.toFixed(2);
            allocationPlanDisplay.innerHTML += `<div class="text-xs p-1 bg-green-50 rounded"><strong>${teamName}:</strong> ${req.quantity.toLocaleString()} requests to <strong>${modelName}</strong> for ${cost} credits</div>`;
        });
    }

    allocationPlanDisplay.innerHTML += '<h4 class="font-semibold text-red-700 mt-4">Unsatisfied Requests</h4>';
    if (!plan || plan.unsatisfied_demand.length === 0) {
        allocationPlanDisplay.innerHTML += `<p class="text-sm text-gray-500">None</p>`;
    } else {
        plan.unsatisfied_demand.forEach(req => {
            const teamName = TEAMS_CONFIG[req.teamId].name;
            const modelName = LLM_MODELS_CONFIG[req.modelId]?.name || req.modelId;
            allocationPlanDisplay.innerHTML += `<div class="text-xs p-1 bg-red-50 rounded"><strong>${teamName}:</strong> ${req.quantity.toLocaleString()} requests to <strong>${modelName}</strong> (${req.reason})</div>`;
        });
    }
}

function renderTeamDashboards() {
    teamDashboardsDisplay.innerHTML = '';
    for (const teamId in teamsState) {
        const teamState = teamsState[teamId];
        const teamConfig = TEAMS_CONFIG[teamId];

        const cardLink = document.createElement('div');
        cardLink.className = `card space-y-2 border-${teamConfig.color}-200`;
        
        cardLink.innerHTML = `
            <h3 class="text-xl font-bold text-${teamConfig.color}-600">${teamConfig.name}</h3>
            <div>
                <span class="font-semibold">Budget:</span> 
                <span class="font-bold text-green-600">${Math.floor(teamState.budget).toLocaleString()} Credits</span>
            </div>
            <div class="text-sm">
                <p><strong>Total Requests Sent:</strong> ${teamState.stats.requestsSent.toLocaleString()}</p>
                 <p><strong>Total Spent:</strong> ${teamState.stats.totalSpent.toFixed(2)} Credits</p>
            </div>
        `;
        teamDashboardsDisplay.appendChild(cardLink);
    }
}

function renderAll(liveCosts, allocationPlan) {
    renderPeriodCounter();
    renderLlmCosts(liveCosts);
    renderPriceList(liveCosts);
    renderAllocationPlan(allocationPlan);
    renderTeamDashboards();
}

// --- 3. EVENT LISTENERS ---
addDemandBtn.addEventListener('click', () => {
    const teamId = document.getElementById('team-selector').value;
    const modelId = document.getElementById('llm-model-selector').value;
    const quantity = parseInt(document.getElementById('request-quantity').value, 10);
    if (quantity > 0) {
        requestIdCounter++;
        demandRequests.push({ id: requestIdCounter, teamId, modelId, quantity });
        renderDemandQueue();
    }
});

runAlgorithmBtn.addEventListener('click', runMarketClearingPeriod);

fetchModelsBtn.addEventListener('click', async () => {
    PORTKEY_API_KEY = portkeyApiKeyInput.value;
    const liveCosts = await fetchLLMCostsFromPortkey();
    if (liveCosts) {
        // Reset and re-initialize the UI with live data
        periodCounter = 0;
        demandRequests = [];
        initializeTeamsState();
        initializePriceCharts();
        populateDropdowns();
        renderAll(liveCosts, { satisfied_demand: [], unsatisfied_demand: [] });
    }
});


// --- 4. INITIALIZATION ---
window.addEventListener('DOMContentLoaded', async () => {
    await loadStaticConfigs();
    initializeTeamsState();
    populateDropdowns(); // Will show "fetch models first"
    renderPeriodCounter();
    renderDemandQueue();
    renderTeamDashboards();
    renderAllocationPlan(null);
    renderLlmCosts(null);
    renderPriceList(null);
});

