// Contract Attachments Handler
// Add this code to pdf-sign.html

// Global attachment data storage
const attachmentData = {
    license_photo: { type: 'text', value: null },
    container_location_doc: { type: 'text', value: null },
    commercial_registration: { type: 'text', value: null },
    activity_license: { type: 'text', value: null },
    tax_number: { type: 'text', value: null }
};

// Toggle between text and image input for an attachment field
function toggleAttachmentType(fieldName, type) {
    // Update active button
    const buttons = document.querySelectorAll(`[onclick*="'${fieldName}'"]`);
    buttons.forEach(btn => {
        if (btn.textContent.includes('نص') && type === 'text') {
            btn.classList.add('active');
        } else if (btn.textContent.includes('صورة') && type === 'image') {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Show/hide appropriate input
    const textInput = document.getElementById(`${fieldName}_text`);
    const fileInput = document.getElementById(`${fieldName}_image`);
    const preview = document.getElementById(`${fieldName}_preview`);

    if (type === 'text') {
        textInput.classList.remove('hidden');
        fileInput.classList.add('hidden');
        preview.classList.add('hidden');
        attachmentData[fieldName].type = 'text';
    } else {
        textInput.classList.add('hidden');
        fileInput.classList.remove('hidden');
        attachmentData[fieldName].type = 'image';
    }
}

// Preview uploaded file
function previewFile(fieldName) {
    const fileInput = document.getElementById(`${fieldName}_image`);
    const preview = document.getElementById(`${fieldName}_preview`);
    const file = fileInput.files[0];

    if (!file) return;

    // Validate file size (5MB)
    if (file.size > 5 * 1024 * 1024) {
        alert('حجم الملف كبير جداً. الحد الأقصى 5 ميجابايت');
        fileInput.value = '';
        return;
    }

    // Validate file type
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
        alert('نوع الملف غير مدعوم. يرجى رفع صورة أو PDF');
        fileInput.value = '';
        return;
    }

    // Read and preview file
    const reader = new FileReader();
    reader.onload = function (e) {
        preview.classList.remove('hidden');

        if (file.type.startsWith('image/')) {
            preview.innerHTML = `
        <img src="${e.target.result}" alt="Preview">
        <div class="file-info">${file.name} (${(file.size / 1024).toFixed(2)} KB)</div>
      `;
        } else {
            preview.innerHTML = `
        <div class="file-info">📄 ${file.name} (${(file.size / 1024).toFixed(2)} KB)</div>
      `;
        }

        // Store file data
        attachmentData[fieldName].value = e.target.result;
    };
    reader.readAsDataURL(file);
}

// Collect all attachment data
function collectAttachments() {
    const attachments = [];

    for (const [fieldName, data] of Object.entries(attachmentData)) {
        if (data.type === 'text') {
            const textInput = document.getElementById(`${fieldName}_text`);
            const textValue = textInput ? textInput.value.trim() : '';

            if (textValue) {
                attachments.push({
                    fieldName: fieldName,
                    fieldType: 'text',
                    textValue: textValue,
                    fileData: null
                });
            }
        } else if (data.type === 'image') {
            if (data.value) {
                attachments.push({
                    fieldName: fieldName,
                    fieldType: 'image',
                    textValue: null,
                    fileData: data.value
                });
            }
        }
    }

    return attachments;
}

// Upload attachments to server
async function uploadAttachments(contractId) {
    const attachments = collectAttachments();

    // Skip if no attachments
    if (attachments.length === 0) {
        console.log('No attachments to upload');
        return { success: true, message: 'No attachments' };
    }

    try {
        const response = await fetch(`/api/contracts/${contractId}/attachments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ attachmentsData: attachments })
        });

        if (!response.ok) {
            throw new Error(`Failed to upload attachments: ${response.statusText}`);
        }

        const result = await response.json();
        console.log('Attachments uploaded successfully:', result);
        return { success: true, data: result };
    } catch (error) {
        console.error('Error uploading attachments:', error);
        return { success: false, error: error.message };
    }
}
