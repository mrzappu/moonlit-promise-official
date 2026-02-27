const QRCode = require('qrcode');

class QRGenerator {
    // Generate UPI QR code
    static async generateUPIQRCode(upiId, amount, payeeName, orderId) {
        try {
            // Format UPI URL according to NPCI standards
            const upiUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amount}&cu=INR&tn=${encodeURIComponent('Order ' + orderId)}`;
            
            // Generate QR code as data URL
            const qrCodeDataUrl = await QRCode.toDataURL(upiUrl, {
                errorCorrectionLevel: 'H',
                margin: 1,
                width: 300,
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                }
            });
            
            return {
                success: true,
                qrCode: qrCodeDataUrl,
                upiUrl: upiUrl,
                upiId: upiId,
                amount: amount,
                orderId: orderId
            };
        } catch (error) {
            console.error('QR Generation Error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Generate multiple QR codes for different amounts (useful for testing)
    static async generateSampleQRs() {
        const upiId = 'sportswear@okhdfcbank';
        const payeeName = 'SportsWear';
        const amounts = [499, 999, 1499, 1999, 2499];
        const qrs = [];
        
        for (const amount of amounts) {
            const orderId = 'SAMPLE' + Date.now() + amount;
            const result = await this.generateUPIQRCode(upiId, amount, payeeName, orderId);
            if (result.success) {
                qrs.push({
                    amount: amount,
                    qrCode: result.qrCode
                });
            }
        }
        
        return qrs;
    }
    
    // Parse UPI payment response (for future use)
    static parseUPIPaymentResponse(response) {
        // This would parse the callback from UPI apps
        // Format: <app>://pay?txnId=XXX&status=success&amount=XXX
        const params = new URLSearchParams(response.split('?')[1]);
        return {
            transactionId: params.get('txnId'),
            status: params.get('status'),
            amount: params.get('amount'),
            reference: params.get('ref')
        };
    }
}

module.exports = QRGenerator;
