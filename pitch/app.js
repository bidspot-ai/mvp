// script.js
function showSection(sectionId) {
    document.querySelectorAll('section').forEach(sec => sec.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');
}

function updateRole() {
    const role = document.getElementById('role').value;
    // Simulate role-based changes; for demo, just alert
    alert(`Role changed to: ${role.charAt(0).toUpperCase() + role.slice(1).replace('-', ' ')}`);
    // Could hide/show elements based on role, but keeping simple
}

// Fluctuating spot prices
function updateSpotPrices() {
    const fluctuate = (base) => (base + Math.random() * 0.2 - 0.1).toFixed(2);
    document.getElementById('spot-price-a100').textContent = fluctuate(0.50);
    document.getElementById('spot-price-h100').textContent = fluctuate(1.20);
    document.getElementById('spot-price-v100').textContent = fluctuate(0.30);
}

setInterval(updateSpotPrices, 5000); // Update every 5 seconds

// Simulate order book
function updateOrderBook() {
    const body = document.getElementById('order-book-body');
    body.innerHTML = '';
    for (let i = 5; i > 0; i--) {
        const bidPrice = (0.50 - i * 0.02).toFixed(2);
        const bidQty = Math.floor(Math.random() * 50) + 10;
        const askPrice = (0.50 + i * 0.02).toFixed(2);
        const askQty = Math.floor(Math.random() * 50) + 10;
        body.innerHTML += `<tr><td>${bidPrice}</td><td>${bidQty}</td><td>${askPrice}</td><td>${askQty}</td></tr>`;
    }
}

setInterval(updateOrderBook, 10000); // Update every 10 seconds

function placeBid() {
    const form = document.getElementById('bid-form');
    const data = {
        type: form['workload-type'].value,
        gpu: form['gpu-type'].value,
        qty: form['quantity'].value,
        duration: form['duration'].value,
        priority: form['priority'].value,
        latency: form['latency'].value,
        task: form['task-desc'].value
    };
    
    // Simulate auto recommendation
    const rec = document.getElementById('auto-recommendation');
    rec.textContent = `AI Recommendation: Suggested bid price: $${(0.5 * data.qty * data.duration).toFixed(2)}. Estimated wait time: ${data.priority === 'high' ? 'Immediate' : '5-10 min'}.`;
    
    // Add to history
    const list = document.getElementById('bid-list');
    const li = document.createElement('li');
    li.textContent = `${data.type} on ${data.gpu.toUpperCase()} x${data.qty} for ${data.duration} hours - Priority: ${data.priority}`;
    list.appendChild(li);
    
    alert('Bid placed successfully!');
}

function updateSettings() {
    const form = document.getElementById('settings-form');
    const team = form['team'].value;
    const weight = form['weight'].value;
    document.getElementById('settings-feedback').textContent = `Updated weight for ${team.toUpperCase()} to ${weight}. Allocation adjusted.`;
    alert('Settings updated!');
}

// Initial calls
updateSpotPrices();
updateOrderBook();
showSection('dashboard');
