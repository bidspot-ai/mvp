document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const dataParam = params.get('data');

    if (!dataParam) {
        document.getElementById('team-name-header').textContent = 'Error: No data provided.';
        return;
    }

    try {
        const decodedData = JSON.parse(decodeURIComponent(dataParam));
        const { teamId, teamConfig, teamState, runningJobs, completedJobs, workloadConfig } = decodedData;

        // --- Render Header and Stats ---
        const teamNameHeader = document.getElementById('team-name-header');
        teamNameHeader.textContent = `${teamConfig.name} Dashboard`;
        teamNameHeader.classList.add(`text-${teamConfig.color}-600`);

        document.getElementById('team-budget').textContent = Math.floor(teamState.budget).toLocaleString();
        document.getElementById('team-spent').textContent = Math.floor(teamState.stats.totalSpent).toLocaleString();
        document.getElementById('team-jobs-run').textContent = teamState.stats.jobsRun;

        // --- Render Running Jobs ---
        const runningJobsList = document.getElementById('running-jobs-list');
        runningJobsList.innerHTML = '';
        if (runningJobs.length > 0) {
            runningJobs.forEach(job => {
                const shape = workloadConfig[job.shape];
                const el = document.createElement('div');
                el.className = 'p-3 bg-gray-50 rounded-lg border';
                el.innerHTML = `
                    <p class="font-semibold">${shape.name} (${job.gpus} GPUs)</p>
                    <div class="text-sm text-gray-600">
                        <span>Cluster: <strong class="text-indigo-600">${job.clusterId}</strong></span> |
                        <span>Ends in Period: <strong>${job.completionPeriod}</strong></span>
                    </div>
                `;
                runningJobsList.appendChild(el);
            });
        } else {
            runningJobsList.innerHTML = '<p class="text-gray-500">No running jobs.</p>';
        }

        // --- Render Completed Jobs ---
        const completedJobsList = document.getElementById('completed-jobs-list');
        completedJobsList.innerHTML = '';
        if (completedJobs.length > 0) {
            completedJobs.slice().reverse().forEach(job => { // Show most recent first
                const shape = workloadConfig[job.shape];
                 const el = document.createElement('div');
                el.className = 'p-3 bg-gray-50 rounded-lg border';
                el.innerHTML = `
                    <p class="font-semibold">${shape.name} (${job.gpus} GPUs)</p>
                    <div class="text-sm text-gray-600">
                        <span>Ran from P${job.startPeriod} to P${job.completionPeriod}</span> |
                        <span>Cost: <strong class="text-red-500">${job.cost ? job.cost.toFixed(0) : 'N/A'} BSC</strong></span>
                    </div>
                `;
                completedJobsList.appendChild(el);
            });
        } else {
            completedJobsList.innerHTML = '<p class="text-gray-500">No completed jobs yet.</p>';
        }

    } catch (e) {
        console.error("Failed to parse team data from URL", e);
        document.getElementById('team-name-header').textContent = 'Error: Could not load team data.';
    }
});
