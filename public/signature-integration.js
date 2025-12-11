/* signature-integration.js  –  glue between page & server signing */
async function uploadContractForSigning() {
  // reuse the same function already defined in index.html
  if (typeof window.uploadContractForSigning === 'function') {
    return window.uploadContractForSigning();
  }
  alert('لم يتم تحميل نظام التوقيع الإلكتروني. يرجى تحديث الصفحة.');
}