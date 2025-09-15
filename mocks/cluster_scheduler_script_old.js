// Set up the canvas and context
const canvas = document.getElementById('gpuCanvas');
const ctx = canvas.getContext('2d');

// Configuration for the cluster
const numMachines = 9;
const gpusPerMachine = 8;
const gpuRows = 2;
const gpuCols = 4;
const totalGpus = numMachines * gpusPerMachine;

// Data structures for visualization
let machines = [];
let particles = [];
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
const messageText = document.getElementById('messageText'); // Add this line to select the message element

// Animation state
let animationId = null;
let intervalId = null;
let gpuUtilization = Array(totalGpus).fill(0);
let activeJobCount = 0;

// Job types based on the user's request
// If you ever display price/cost, use BidSpotCredits (BSC)
const jobTypes = {
    'AI Inference': { count: 10, gpusPerJob: 1, color: '#f87171' },
    'Training Batch': { count: 6, gpusPerJob: 4, color: '#34d399' },
    'Large Training': { count: 3, gpusPerJob: 8, color: '#a78bfa' }
};

const freeColor = '#60a5fa';

// Resize function for canvas
const resizeCanvas = () => {
    canvas.width = canvas.parentElement.offsetWidth;
    canvas.height = canvas.parentElement.offsetHeight;
    updateGpuPositions();
    drawDashboard();
};

// Function to position GPUs in a 2x4 grid within each machine box
const updateGpuPositions = () => {
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    // Machine box dimensions
    const gpuSize = 15;
    const horizontalSpacing = 20;
    const verticalSpacing = 20;
    const gridWidth = (gpuCols * (gpuSize * 2)) + ((gpuCols - 1) * horizontalSpacing);
    const gridHeight = (gpuRows * (gpuSize * 2)) + ((gpuRows - 1) * verticalSpacing);
    const machineWidth = gridWidth + 60; // Add padding
    const machineHeight = gridHeight + 60; // Add padding

    // Add more space between machine boxes
    const machineGridRows = 3;
    const machineGridCols = 3;
    const machineBoxGap = 32; // Increased gap between machine boxes

    const totalClusterWidth = (machineWidth * machineGridCols) + (machineBoxGap * (machineGridCols - 1));
    const totalClusterHeight = (machineHeight * machineGridRows) + (machineBoxGap * (machineGridRows - 1));

    const startX = centerX - totalClusterWidth / 2;
    const startY = centerY - totalClusterHeight / 2;

    machines = [];
    for (let i = 0; i < numMachines; i++) {
        const machineRow = Math.floor(i / machineGridCols);
        const machineCol = i % machineGridCols;

        const machineX = startX + machineCol * (machineWidth + machineBoxGap);
        const machineY = startY + machineRow * (machineHeight + machineBoxGap);

        const machineGpus = [];

        for (let j = 0; j < gpusPerMachine; j++) {
            const row = Math.floor(j / gpuCols);
            const col = j % gpuCols;

            // Calculate position of each GPU, centered within the machine box
            const gpuX = (machineX + 30) + (col * (gpuSize * 2 + horizontalSpacing)) + gpuSize;
            const gpuY = (machineY + 30) + (row * (gpuSize * 2 + verticalSpacing)) + gpuSize;

            machineGpus.push({
                x: gpuX,
                y: gpuY,
                size: gpuSize,
                color: freeColor,
                globalIndex: i * gpusPerMachine + j
            });
        }

        machines.push({
            x: machineX,
            y: machineY,
            width: machineWidth,
            height: machineHeight,
            gpus: machineGpus
        });
    }
};

// Function to draw the dashboard
const drawDashboard = () => {
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.shadowBlur = 0;

    // Draw each machine stack
    machines.forEach((machine, machineIndex) => {
        // Draw machine box with rounded corners and border
        const boxX = machine.x;
        const boxY = machine.y;
        const borderRadius = 15;
        
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, machine.width, machine.height, borderRadius);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();

        // Draw machine label
        ctx.fillStyle = '#d1d5db';
        ctx.font = '14px Orbitron';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`Machine ${machineIndex + 1}`, boxX + machine.width / 2, boxY + 20);

        // Draw each GPU in the stack
        machine.gpus.forEach((gpu, gpuIndex) => {
            // Draw GPUs as squares
            ctx.beginPath();
            ctx.fillStyle = gpu.color;
            ctx.fillRect(gpu.x - gpu.size, gpu.y - gpu.size, gpu.size * 2, gpu.size * 2);
            ctx.shadowBlur = 0; // Removed the glow by setting blur to 0
            ctx.fill();
        });
    });
};

// Function to update metrics and charts once
const updateMetrics = () => {
    let gpuAssignments = Array(totalGpus).fill('#60a5fa'); // Fill with idle color
    
    const massiveSimColor = jobTypes['Large Training'].color;
    const trainingBatchColor = jobTypes['Training Batch'].color;
    const aiInferenceColor = jobTypes['AI Inference'].color;

    let lastAssignedGpuIndex = 0;
    for (let i = 0; i < jobTypes['Large Training'].count; i++) {
        for (let j = 0; j < gpusPerMachine; j++) {
            gpuAssignments[lastAssignedGpuIndex++] = massiveSimColor;
        }
    }
    
    // Assign the 4 GPU jobs next in order.
    for (let i = 0; i < jobTypes['Training Batch'].count; i++) {
        for (let j = 0; j < 4; ++j) {
            gpuAssignments[lastAssignedGpuIndex++] = trainingBatchColor;
        }
    }

    const inferenceJobsToPlace = jobTypes['AI Inference'].count;
    for(let i = 0; i < inferenceJobsToPlace; i++) {
        gpuAssignments[lastAssignedGpuIndex++] = aiInferenceColor;
    }


    // Update GPU colors and utilization
    machines.forEach(machine => {
        machine.gpus.forEach(gpu => {
            const assignedColor = gpuAssignments[gpu.globalIndex];
            gpu.color = assignedColor;
        });
    });

    // Update DOM elements with static data
    document.querySelector('#totalGpus').textContent = totalGpus;
    
    let totalUsedGpus = 0;
    Object.keys(jobTypes).forEach(jobName => {
        const job = jobTypes[jobName];
        totalUsedGpus += job.count * job.gpusPerJob;
    });
    const freeGpus = totalGpus - totalUsedGpus;

    freeGpusSummaryEl.textContent = freeGpus;
    document.querySelector('#activeJobs').textContent = Object.values(jobTypes).reduce((sum, job) => sum + job.count, 0);
    document.querySelector('#throughput').textContent = `1.2 Peta`;
    document.querySelector('#vram').textContent = totalGpus * 8; // Assuming 8GB per GPU

    // Update job summary box
    const summaryHTML = Object.keys(jobTypes).map(jobName => {
        const job = jobTypes[jobName];
        return `
            <div class="flex items-center gap-2 p-2 rounded-lg bg-gray-700">
                <div class="w-4 h-4 rounded-full" style="background-color: ${job.color};"></div>
                <div class="text-sm">
                    <span class="font-bold">${jobName}</span>
                    <br>
                    <span class="text-gray-400">${job.count} jobs | ${job.count * job.gpusPerJob} GPUs</span>
                </div>
            </div>
        `;
    }).join('');
    jobSummaryBoxEl.innerHTML = summaryHTML;

    // Generate a random incoming job queue
    const numQueuedJobs = Math.floor(Math.random() * 5) + 3; // 3 to 7 jobs in the queue
    const queuedJobsHTML = Array.from({ length: numQueuedJobs }).map(() => {
        const jobName = jobNames[Math.floor(Math.random() * jobNames.length)];
        const jobColor = jobColors[Math.floor(Math.random() * jobColors.length)];
        return `
            <div class="w-4 h-4 rounded-sm" style="background-color: ${jobColor};" title="${jobName}"></div>
        `;
    }).join('');
    incomingJobsQueueEl.innerHTML = queuedJobsHTML;
    
    drawDashboard();
};

setJobsButton.addEventListener('click', () => {
    const numJobs = parseInt(jobCountInput.value, 10);
    const jobType = jobTypeDropdown.value;
    const gpusPerJob = jobTypes[jobType].gpusPerJob;
    
    if (!isNaN(numJobs) && numJobs >= 0) {
        // Calculate available GPUs
        let usedGpus = 0;
        Object.keys(jobTypes).forEach(name => {
            if (name !== jobType) {
                usedGpus += jobTypes[name].count * jobTypes[name].gpusPerJob;
            }
        });
        
        const availableGpus = totalGpus - usedGpus;
        const requiredGpus = numJobs * gpusPerJob;
        
        if (requiredGpus > availableGpus) {
            // Display an on-screen message instead of an alert
            messageText.textContent = `Cannot assign ${numJobs} of ${jobType} jobs. Only ${availableGpus} GPUs are available.`;
            jobCountInput.value = Math.floor(availableGpus / gpusPerJob);
            jobTypes[jobType].count = Math.floor(availableGpus / gpusPerJob);
        } else {
            jobTypes[jobType].count = numJobs;
            messageText.textContent = '';
        }
        updateMetrics();
    }
});

// Initial setup and event listeners
window.addEventListener('resize', resizeCanvas);

window.onload = () => {
    resizeCanvas();
    updateMetrics();
};
