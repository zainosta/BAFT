// Create signature pad directly in the signing modal
// Remove the old signature-pad.js file and add this:
window.initSignaturePad = function() {
    console.log("Initializing signature pad");
    
    const canvas = document.getElementById('signature-pad-canvas');
    if (!canvas) {
        console.log("Canvas not found");
        return;
    }
    
    // Set canvas dimensions
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = 300 * 2;
    
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#000000";
    
    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;
    
    // Drawing functions
    function startDrawing(e) {
        isDrawing = true;
        [lastX, lastY] = [e.offsetX, e.offsetY];
    }
    
    function draw(e) {
        if (!isDrawing) return;
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(e.offsetX, e.offsetY);
        ctx.stroke();
        [lastX, lastY] = [e.offsetX, e.offsetY];
    }
    
    function stopDrawing() {
        isDrawing = false;
    }
    
    // Mouse events
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);
    
    // Touch events
    canvas.addEventListener('touchstart', function(e) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousedown', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        canvas.dispatchEvent(mouseEvent);
    });
    
    canvas.addEventListener('touchmove', function(e) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousemove', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        canvas.dispatchEvent(mouseEvent);
    });
    
    canvas.addEventListener('touchend', function(e) {
        e.preventDefault();
        const mouseEvent = new MouseEvent('mouseup', {});
        canvas.dispatchEvent(mouseEvent);
    });
    
    // Clear button
    document.getElementById('clear-signature')?.addEventListener('click', function() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    });
    
    // Save button
    document.getElementById('save-signature-btn')?.addEventListener('click', function() {
        const dataURL = canvas.toDataURL('image/png');
        if (dataURL && dataURL.length > 100) {
            alert('تم حفظ التوقيع!');
        } else {
            alert('يرجى التوقيع أولاً');
        }
    });
};