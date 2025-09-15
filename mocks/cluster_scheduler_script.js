// Set up the canvas and context
const canvas = document.getElementById('gpuCanvas');
const ctx = canvas.getContext('2d');

// --- Configuration for the cluster (will be updated from URL) ---
let CLUSTER_CONFIG = {
    numMachines: 9,
    gpusPerMachine: 8,
};

// Data structures for visualization
let machines = [];
const jobColors = ['#a78bfa', '#fcd34d', '#60a5fa', '#f87171', '#34d399'];
const jobNames = ['AI Training', 'Data Analysis', '3D Rendering', 'Neural Net', 'Cryptography'];

// DOM elements
const activeJobsEl = document.getElementById('activeJobs');
const throughputEl = document.getElementById('throughput');
const jobListEl = document.getElementById('jobList');
const utilizationChartEl = document.getElementById('utilizationChart');
const bandwidthChartEl = document.getElementById('bandwidthChart');
const incomingJobsQueueEl = document.getElementById('incomingJobsQueue');
const jobSummaryBoxEl = document.getElementById('jobSummaryBox');
const freeGpusSummaryEl = document.getElementById('freeGpusSummary');
const jobTypeDropdown = document.getElementById('jobTypeDropdown');
const jobCountInput = document.getElementById('jobCountInput');
const setJobsButton = document.getElementById('setJobsButton');
const messageText = document.getElementById('messageText');
const clusterIdDisplay = document.getElementById('cluster-id-display');
const manualControls = document.getElementById('manual-controls');

// Animation state
let animationId = null;
let intervalId = null;
let gpuUtilization = Array(totalGpus).fill(0);
let activeJobCount = 0;

// Job types definition
const jobTypes = {
    'AI Inference': { count: 0, gpusPerJob: 1, color: '#f87171' },
    'Training Batch': { count: 0, gpusPerJob: 4, color: '#34d399' },
    'Large Training': { count: 0, gpusPerJob: 8, color: '#a78bfa' }
};

// Mapping from simulator shape names to scheduler job names
const jobTypesMap = {
    'inference': 'AI Inference',
    'training_batch': 'Training Batch',
    'large_training': 'Large Training'
};

const freeColor = '#e5e7eb';

// Resize function for canvas
const resizeCanvas = () => {
    canvas.width = canvas.parentElement.offsetWidth;
    canvas.height = canvas.parentElement.offsetHeight;
    updateGpuPositions();
    drawDashboard();
};

/**
 * Always use 2 rows for GPUs in each machine box.
 * The number of columns is calculated based on the total number of GPUs per machine.
 * If GPUs can't fit, shrink their size to fit all within the box (no scrollbar).
 */
function getGpuGrid(numGpus) {
    const rows = 2;
    const cols = Math.ceil(numGpus / rows);
    return { rows, cols };
}

function updateGpuPositions() {
    // Get canvas size
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // Get number of machines and GPUs per machine from config or state
    const numMachines = CLUSTER_CONFIG.numMachines || 9;
    const gpusPerMachine = CLUSTER_CONFIG.gpusPerMachine || 8;

    // Calculate grid for machines: try to have the same number of machines in each row
    // Find the closest factor pair (cols, rows) such that cols*rows >= numMachines and |cols-rows| is minimized
    let bestCols = 1, bestRows = numMachines;
    let minDiff = numMachines;
    for (let cols = 1; cols <= Math.ceil(Math.sqrt(numMachines)); cols++) {
        let rows = Math.ceil(numMachines / cols);
        if (cols * rows >= numMachines && Math.abs(cols - rows) < minDiff) {
            bestCols = cols;
            bestRows = rows;
            minDiff = Math.abs(cols - rows);
        }
    }
    const machineGridCols = bestCols;
    const machineGridRows = bestRows;

    // Calculate max available width/height for each machine box
    const margin = 32;
    const machineBoxGap = 24;
    const availableWidth = canvasWidth - margin * 2 - (machineGridCols - 1) * machineBoxGap;
    const availableHeight = canvasHeight - margin * 2 - (machineGridRows - 1) * machineBoxGap;
    // Make machine box square: use the smaller of width/height per box
    const maxBoxWidth = Math.floor(availableWidth / machineGridCols);
    const maxBoxHeight = Math.floor(availableHeight / machineGridRows);
    const machineBoxSize = Math.min(maxBoxWidth, maxBoxHeight);

    // Calculate grid for GPUs in each machine (always 2 rows)
    const { rows: gpuRows, cols: gpuCols } = getGpuGrid(gpusPerMachine);

    // Calculate GPU size and spacing to fit in the machine box
    const gpuPadding = 20;
    // Dynamically resize GPU size to fit, but clamp between 8 and 32
    const maxGpuWidth = Math.floor((machineBoxSize - gpuPadding * 2) / gpuCols);
    const maxGpuHeight = Math.floor((machineBoxSize - gpuPadding * 2) / gpuRows);
    const gpuSize = Math.max(8, Math.min(maxGpuWidth, maxGpuHeight, 32));
    const horizontalSpacing = gpuCols > 1 ? Math.floor((machineBoxSize - gpuPadding * 2 - gpuSize * gpuCols) / (gpuCols - 1)) : 0;
    const verticalSpacing = gpuRows > 1 ? Math.floor((machineBoxSize - gpuPadding * 2 - gpuSize * gpuRows) / (gpuRows - 1)) : 0;

    // Center the grid of machines
    const totalClusterWidth = machineGridCols * machineBoxSize + (machineGridCols - 1) * machineBoxGap;
    const totalClusterHeight = machineGridRows * machineBoxSize + (machineGridRows - 1) * machineBoxGap;
    const startX = (canvasWidth - totalClusterWidth) / 2;
    const startY = (canvasHeight - totalClusterHeight) / 2;

    machines = [];
    for (let i = 0; i < numMachines; i++) {
        const machineRow = Math.floor(i / machineGridCols);
        const machineCol = i % machineGridCols;

        const machineX = startX + machineCol * (machineBoxSize + machineBoxGap);
        const machineY = startY + machineRow * (machineBoxSize + machineBoxGap);

        const machineGpus = [];

        for (let j = 0; j < gpusPerMachine; j++) {
            const row = Math.floor(j / gpuCols);
            const col = j % gpuCols;

            // Calculate position of each GPU, centered within the machine box
            const gpuX = machineX + gpuPadding + col * (gpuSize + horizontalSpacing) + gpuSize / 2;
            const gpuY = machineY + gpuPadding + row * (gpuSize + verticalSpacing) + gpuSize / 2;

            machineGpus.push({
                x: gpuX,
                y: gpuY,
                size: gpuSize / 2,
                color: '#60a5fa',
                globalIndex: i * gpusPerMachine + j
            });
        }

        machines.push({
            x: machineX,
            y: machineY,
            width: machineBoxSize,
            height: machineBoxSize,
            gpus: machineGpus
        });
    }
}

// Function to draw the dashboard
const drawDashboard = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    machines.forEach((machine, machineIndex) => {
        const boxX = machine.x;
        const boxY = machine.y;
        const boxSize = machine.width; // square
        const borderRadius = 15;

        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxSize, boxSize, borderRadius);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();

        // Font size scales with box size, min 8px, max 18px
        const fontSize = Math.max(8, Math.min(18, Math.floor(boxSize / 10)));
        ctx.fillStyle = '#d1d5db';
        ctx.font = `${fontSize}px Orbitron`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`Machine ${machineIndex + 1}`, boxX + boxSize / 2, boxY + fontSize + 2);

        machine.gpus.forEach((gpu) => {
            ctx.beginPath();
            ctx.fillStyle = gpu.color;
            ctx.fillRect(gpu.x - gpu.size, gpu.y - gpu.size, gpu.size * 2, gpu.size * 2);
            ctx.fill();
        });
    });
};

// --- New Allocation and UI Functions ---

function updateUIData() {
    const totalGpus = CLUSTER_CONFIG.numMachines * CLUSTER_CONFIG.gpusPerMachine;
    const totalUsedGpus = Object.values(jobTypes).reduce((sum, job) => sum + job.count * job.gpusPerJob, 0);
    const freeGpus = totalGpus - totalUsedGpus;

    freeGpusSummaryEl.textContent = freeGpus;
    document.querySelector('#totalGpus').textContent = totalGpus;
    document.querySelector('#activeJobs').textContent = Object.values(jobTypes).reduce((sum, job) => sum + job.count, 0);
    document.querySelector('#vram').textContent = totalGpus * 8; // Assuming 8GB per GPU

    const summaryHTML = Object.keys(jobTypes).map(jobName => {
        const job = jobTypes[jobName];
        if (job.count === 0) return '';
        // If you ever display price/cost, use BSC here
        return `
            <div class="flex items-center gap-2 p-2 rounded-lg bg-gray-100">
                <div class="w-4 h-4 rounded-md" style="background-color: ${job.color};"></div>
                <div class="text-sm text-left">
                    <span class="font-bold">${jobName}</span>
                    <br>
                    <span class="text-gray-500">${job.count} jobs | ${job.count * job.gpusPerJob} GPUs</span>
                </div>
            </div>
        `;
    }).join('');
    jobSummaryBoxEl.innerHTML = summaryHTML || '<p class="text-gray-500">No jobs allocated.</p>';
}


function visualizeAllocation(demand) {
    // Reset machine state and job counts
    machines.forEach(machine => machine.gpus.forEach(gpu => gpu.color = freeColor));
    for (const jobName in jobTypes) { jobTypes[jobName].count = 0; }

    const machineAllocation = machines.map(() => []);

    demand.forEach(jobRequest => {
        const jobName = jobTypesMap[jobRequest.shape];
        if (!jobName) return;

        const jobDef = jobTypes[jobName];
        let placedJobs = 0;

        for (let i = 0; i < jobRequest.quantity; i++) {
            for (let m = 0; m < machines.length; m++) {
                const usedGpusOnMachine = machineAllocation[m].reduce((sum, job) => sum + job.gpusPerJob, 0);
                if ((CLUSTER_CONFIG.gpusPerMachine - usedGpusOnMachine) >= jobDef.gpusPerJob) {
                    machineAllocation[m].push(jobDef);
                    placedJobs++;
                    break;
                }
            }
        }
        jobTypes[jobName].count = placedJobs;
    });

    machineAllocation.forEach((jobs, machineIndex) => {
        let gpuIndex = 0;
        jobs.forEach(job => {
            for(let i = 0; i < job.gpusPerJob; i++) {
                if(gpuIndex < CLUSTER_CONFIG.gpusPerMachine) {
                    machines[machineIndex].gpus[gpuIndex].color = job.color;
                    gpuIndex++;
                }
            }
        });
    });
    
    updateUIData();
    drawDashboard();
}

// --- Initial Setup and Event Listeners ---
function initializeFromURL() {
    const params = new URLSearchParams(window.location.search);
    const clusterId = params.get('clusterId');
    const configParam = params.get('config');
    const demandParam = params.get('demand');
    const yamlParam = params.get('yaml');

    if (yamlParam) {
        // --- YAML input mode ---
        try {
            const yamlStr = decodeURIComponent(escape(window.atob(yamlParam)));
            const parsed = jsyaml.load(yamlStr);
            clusterIdDisplay.textContent = 'YAML Input';
            manualControls.style.display = 'none';
            // For demo: show a summary of clusters and jobs
            let summary = '<div class="p-4 bg-gray-100 rounded mb-4"><b>YAML Input Parsed:</b><br><pre style="font-size:0.95em;max-height:300px;overflow:auto;">' + yamlStr.replace(/</g,'&lt;') + '</pre></div>';
            document.body.insertAdjacentHTML('afterbegin', summary);
            // You can now use 'parsed' for further logic, e.g., visualizeAllocation, etc.
        } catch (e) {
            clusterIdDisplay.textContent = 'YAML Error';
            document.body.insertAdjacentHTML('afterbegin', `<div class='p-4 bg-red-100 rounded mb-4'>YAML Parse Error: ${e}</div>`);
        }
        resizeCanvas();
        updateUIData();
        drawDashboard();
        return;
    }

    if (clusterId && configParam && demandParam) {
        clusterIdDisplay.textContent = clusterId;
        try {
            const config = JSON.parse(decodeURIComponent(configParam));
            const demand = JSON.parse(decodeURIComponent(demandParam));

            CLUSTER_CONFIG.numMachines = config.numMachines;
            
            manualControls.style.display = 'none';

            resizeCanvas(); // Recalculate layout with new config
            visualizeAllocation(demand);

        } catch (e) {
            console.error("Error parsing URL parameters:", e);
            clusterIdDisplay.textContent = 'Error';
        }
    } else {
        clusterIdDisplay.textContent = 'Manual Mode';
        resizeCanvas();
        updateUIData();
        drawDashboard();
    }
}

setJobsButton.addEventListener('click', () => {
    const numJobs = parseInt(jobCountInput.value, 10);
    const jobType = jobTypeDropdown.value;
    
    if (!isNaN(numJobs) && numJobs >= 0) {
        jobTypes[jobType].count = numJobs; // Update one job type
        
        const demand = Object.entries(jobTypes).map(([name, data]) => {
            const shape = Object.keys(jobTypesMap).find(key => jobTypesMap[key] === name);
            return { shape: shape, quantity: data.count };
        });
        
        visualizeAllocation(demand);
    }
});


window.addEventListener('resize', resizeCanvas);
window.onload = initializeFromURL;

