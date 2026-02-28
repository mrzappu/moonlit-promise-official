const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

class DiscordLogger {
    constructor() {
        this.client = new Client({ 
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers
            ] 
        });
        this.ready = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.messageQueue = [];
        
        this.channels = {
            // Auth
            login: process.env.DISCORD_LOGIN_CHANNEL,
            logout: process.env.DISCORD_LOGOUT_CHANNEL,
            register: process.env.DISCORD_REGISTER_CHANNEL,
            
            // Products
            productView: process.env.DISCORD_PRODUCT_VIEW_CHANNEL,
            productAdd: process.env.DISCORD_PRODUCT_ADD_CHANNEL,
            productEdit: process.env.DISCORD_PRODUCT_EDIT_CHANNEL,
            productDelete: process.env.DISCORD_PRODUCT_DELETE_CHANNEL,
            
            // Cart
            cartAdd: process.env.DISCORD_CART_ADD_CHANNEL,
            cartRemove: process.env.DISCORD_CART_REMOVE_CHANNEL,
            cartView: process.env.DISCORD_CART_VIEW_CHANNEL,
            
            // Orders
            orderCreate: process.env.DISCORD_ORDER_CREATE_CHANNEL,
            orderUpdate: process.env.DISCORD_ORDER_UPDATE_CHANNEL,
            orderStatus: process.env.DISCORD_ORDER_STATUS_CHANNEL,
            orderComplete: process.env.DISCORD_ORDER_COMPLETE_CHANNEL,
            
            // Payments
            paymentInit: process.env.DISCORD_PAYMENT_INIT_CHANNEL,
            paymentSuccess: process.env.DISCORD_PAYMENT_SUCCESS_CHANNEL,
            paymentFailed: process.env.DISCORD_PAYMENT_FAILED_CHANNEL,
            paymentRefund: process.env.DISCORD_PAYMENT_REFUND_CHANNEL,
            
            // Admin
            adminLogin: process.env.DISCORD_ADMIN_LOGIN_CHANNEL,
            adminAction: process.env.DISCORD_ADMIN_ACTION_CHANNEL,
            adminProduct: process.env.DISCORD_ADMIN_PRODUCT_CHANNEL,
            
            // System
            error: process.env.DISCORD_ERROR_CHANNEL,
            system: process.env.DISCORD_SYSTEM_CHANNEL,
            backup: process.env.DISCORD_BACKUP_CHANNEL
        };

        this.init();
    }

    async init() {
        try {
            console.log('🔄 Initializing Discord bot...');
            console.log('🔑 Token exists:', !!process.env.DISCORD_BOT_TOKEN);
            console.log('🔑 Token length:', process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.length : 0);

            if (!process.env.DISCORD_BOT_TOKEN) {
                throw new Error('DISCORD_BOT_TOKEN is not defined in environment variables');
            }

            this.client.on('ready', () => {
                console.log(`✅ Discord bot connected as ${this.client.user.tag}`);
                console.log(`   Bot ID: ${this.client.user.id}`);
                console.log(`   Serving ${this.client.guilds.cache.size} guilds`);
                this.ready = true;
                this.reconnectAttempts = 0;
                this.processQueue();
                this.logSystem('Discord bot connected successfully', 'success');
            });

            this.client.on('error', (error) => {
                console.error('❌ Discord client error:', error.message);
                this.ready = false;
                
                if (error.code === 'TokenInvalid') {
                    console.error('   → Invalid bot token. Reset it in Discord Developer Portal');
                } else if (error.code === 'DISALLOWED_INTENTS') {
                    console.error('   → Missing required intents. Enable them in Discord Developer Portal');
                }
            });

            this.client.on('disconnect', () => {
                console.log('⚠️ Discord bot disconnected');
                this.ready = false;
                this.reconnect();
            });

            console.log('🔑 Attempting to login to Discord...');
            await this.client.login(process.env.DISCORD_BOT_TOKEN);
            
        } catch (error) {
            console.error('❌ Failed to connect Discord logger:', error.message);
            this.ready = false;
            
            if (error.code === 'TokenInvalid') {
                console.error('   → The bot token is invalid. Reset it in Discord Developer Portal');
            } else if (error.code === 'DISALLOWED_INTENTS') {
                console.error('   → Missing required intents. Enable them in Discord Developer Portal');
            }
            
            this.reconnect();
        }
    }

    async reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached. Giving up.');
            return;
        }

        this.reconnectAttempts++;
        console.log(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${this.reconnectDelay/1000}s...`);

        setTimeout(() => {
            this.init();
        }, this.reconnectDelay);

        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
    }

    async processQueue() {
        if (this.messageQueue.length === 0) return;
        
        console.log(`📨 Processing ${this.messageQueue.length} queued messages...`);
        
        for (const queued of this.messageQueue) {
            try {
                await this.sendToChannel(queued.channelId, queued.message, queued.embed, queued.file);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error('Error sending queued message:', error);
            }
        }
        
        this.messageQueue = [];
        console.log('✅ Queue processed');
    }

    async sendToChannel(channelId, message, embed = null, file = null) {
        if (!this.ready) {
            this.messageQueue.push({ channelId, message, embed, file });
            if (this.messageQueue.length === 1) {
                console.log('⏳ Bot initializing - messages queued');
            }
            return;
        }

        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel) {
                console.error(`❌ Channel ${channelId} not found`);
                return;
            }

            const content = {
                content: message ? message.substring(0, 2000) : null,
                embeds: embed ? [embed] : []
            };
            
            if (file) {
                if (typeof file === 'string' && fs.existsSync(file)) {
                    content.files = [file];
                } else if (file?.path && fs.existsSync(file.path)) {
                    content.files = [file.path];
                }
            }
            
            await channel.send(content);
        } catch (error) {
            console.error(`❌ Failed to send to Discord:`, error.message);
        }
    }

    createEmbed(title, description, color = 0x00ff00, fields = [], footer = null) {
        const embed = new EmbedBuilder()
            .setTitle(title.substring(0, 256))
            .setDescription(description.substring(0, 4096))
            .setColor(color)
            .setTimestamp();
        
        if (fields && fields.length > 0) {
            embed.addFields(fields.map(f => ({
                name: f.name.substring(0, 256),
                value: f.value.substring(0, 1024),
                inline: f.inline || false
            })));
        }
        
        if (footer) {
            embed.setFooter({ text: footer.substring(0, 2048) });
        }
        
        return embed;
    }

    // ==================== AUTHENTICATION LOGS ====================

    async logLogin(user, ip, method = 'Discord') {
        const fields = [
            { name: '👤 Username', value: user.username, inline: true },
            { name: '🆔 User ID', value: user.id?.toString() || 'N/A', inline: true },
            { name: '🆔 Discord ID', value: user.discord_id || 'N/A', inline: true },
            { name: '📧 Email', value: user.email || 'Not provided', inline: true },
            { name: '📞 Phone', value: user.phone || 'Not provided', inline: true },
            { name: '🌐 IP Address', value: ip || 'Unknown', inline: true },
            { name: '🔑 Login Method', value: method, inline: true },
            { name: '🤖 Is Admin', value: user.is_admin ? 'Yes' : 'No', inline: true },
            { name: '🕐 Login Time', value: new Date().toLocaleString('en-IN'), inline: true }
        ];
        
        const embed = this.createEmbed(
            '🔐 User Login',
            `**${user.username}** logged into the website`,
            0x00ff00,
            fields,
            'Login Event'
        );
        
        await this.sendToChannel(this.channels.login, null, embed);
    }

    async logLocalLogin(user, ip) {
        await this.logLogin(user, ip, 'Username/Password');
    }

    async logLogout(user) {
        const fields = [
            { name: '👤 Username', value: user.username, inline: true },
            { name: '🆔 User ID', value: user.id?.toString() || 'N/A', inline: true },
            { name: '🕐 Logout Time', value: new Date().toLocaleString('en-IN'), inline: true }
        ];
        
        const embed = this.createEmbed(
            '🚪 User Logout',
            `**${user.username}** logged out`,
            0xffaa00,
            fields,
            'Logout Event'
        );
        
        await this.sendToChannel(this.channels.logout, null, embed);
    }

    async logRegister(user) {
        const fields = [
            { name: '👤 Username', value: user.username, inline: true },
            { name: '🆔 User ID', value: user.id?.toString() || 'N/A', inline: true },
            { name: '🆔 Discord ID', value: user.discord_id || 'N/A', inline: true },
            { name: '📧 Email', value: user.email || 'Not provided', inline: true },
            { name: '📅 Joined', value: new Date().toLocaleString('en-IN'), inline: true }
        ];
        
        const embed = this.createEmbed(
            '📝 New Registration',
            `New user **${user.username}** registered`,
            0x00ff00,
            fields,
            'Registration Event'
        );
        
        await this.sendToChannel(this.channels.register, null, embed);
    }

    async logLocalRegister(user, req) {
        const fields = [
            { name: '👤 Username', value: user.username, inline: true },
            { name: '🆔 User ID', value: user.id?.toString() || 'N/A', inline: true },
            { name: '📧 Email', value: user.email || 'Not provided', inline: true },
            { name: '📞 Phone', value: user.phone || 'Not provided', inline: true },
            { name: '🌐 IP Address', value: req?.ip || 'Unknown', inline: true },
            { name: '📅 Joined', value: new Date().toLocaleString('en-IN'), inline: true }
        ];
        
        const embed = this.createEmbed(
            '📝 New Local Registration',
            `New user **${user.username}** registered`,
            0x00ff00,
            fields,
            'Registration Event'
        );
        
        await this.sendToChannel(this.channels.register, null, embed);
    }

    async logFailedLogin(username, ip, reason = 'Invalid credentials', method = 'Username/Password') {
        const fields = [
            { name: '👤 Attempted Username', value: username || 'Unknown', inline: true },
            { name: '🌐 IP Address', value: ip || 'Unknown', inline: true },
            { name: '❌ Reason', value: reason, inline: true },
            { name: '🕐 Time', value: new Date().toLocaleString('en-IN'), inline: true }
        ];
        
        const embed = this.createEmbed(
            '⚠️ Failed Login Attempt',
            `Failed login attempt for **${username || 'Unknown'}**`,
            0xffaa00,
            fields,
            'Security Alert'
        );
        
        await this.sendToChannel(this.channels.login, null, embed);
    }

    async logAccountLockout(user, ip, reason = 'Too many failed attempts') {
        const fields = [
            { name: '👤 Username', value: user.username, inline: true },
            { name: '🌐 IP Address', value: ip || 'Unknown', inline: true },
            { name: '❌ Reason', value: reason, inline: true },
            { name: '🔒 Lockout Time', value: new Date().toLocaleString('en-IN'), inline: true }
        ];
        
        const embed = this.createEmbed(
            '🔒 Account Lockout',
            `Account **${user.username}** locked`,
            0xff0000,
            fields,
            'Security Alert'
        );
        
        await this.sendToChannel(this.channels.login, null, embed);
    }

    async logPasswordChange(user, ip, changedBy = 'user') {
        const fields = [
            { name: '👤 Username', value: user.username, inline: true },
            { name: '🌐 IP Address', value: ip || 'Unknown', inline: true },
            { name: '✏️ Changed By', value: changedBy === 'user' ? 'User' : 'Admin', inline: true },
            { name: '🕐 Time', value: new Date().toLocaleString('en-IN'), inline: true }
        ];
        
        const embed = this.createEmbed(
            '✏️ Password Changed',
            `Password changed for **${user.username}**`,
            0xffaa00,
            fields,
            'Security Update'
        );
        
        await this.sendToChannel(this.channels.login, null, embed);
    }

    async logAccountRecovery(email, ip) {
        const fields = [
            { name: '📧 Email', value: email || 'Unknown', inline: true },
            { name: '🌐 IP Address', value: ip || 'Unknown', inline: true },
            { name: '🕐 Time', value: new Date().toLocaleString('en-IN'), inline: true }
        ];
        
        const embed = this.createEmbed(
            '🔄 Account Recovery',
            `Password reset requested for **${email || 'Unknown'}**`,
            0xffaa00,
            fields,
            'Security Alert'
        );
        
        await this.sendToChannel(this.channels.login, null, embed);
    }

    // ==================== ORDER LOGS ====================

    async logOrderCreate(user, order, orderItems, shippingDetails) {
        let totalAmount = 0;
        let itemsList = '';
        
        orderItems.forEach((item, index) => {
            if (index < 5) {
                itemsList += `**${item.name}** x${item.quantity} = ₹${item.price * item.quantity}\n`;
            }
            totalAmount += item.price * item.quantity;
        });

        const fields = [
            { name: '📋 Order Number', value: order.order_number, inline: true },
            { name: '💰 Total', value: `₹${totalAmount.toFixed(2)}`, inline: true },
            { name: '💳 Payment', value: order.payment_method, inline: true },
            { name: '👤 Customer', value: user.username, inline: true },
            { name: '📞 Phone', value: shippingDetails.phone || order.phone || 'N/A', inline: true },
            { name: '📍 Address', value: shippingDetails.fullAddress || order.shipping_address || 'N/A', inline: false },
            { name: '🛍️ Items', value: itemsList || 'No items', inline: false }
        ];
        
        const embed = this.createEmbed(
            '📦 New Order',
            `Order #${order.order_number} placed`,
            0x00ff00,
            fields
        );
        
        await this.sendToChannel(this.channels.orderCreate, null, embed);
    }

    async logOrderUpdate(user, order, oldStatus, newStatus, updatedBy = 'system') {
        const fields = [
            { name: '📋 Order', value: order.order_number, inline: true },
            { name: '💰 Amount', value: `₹${order.total_amount}`, inline: true },
            { name: '📊 Old Status', value: oldStatus, inline: true },
            { name: '📊 New Status', value: newStatus, inline: true }
        ];
        
        const embed = this.createEmbed(
            '🔄 Order Updated',
            `Order #${order.order_number} updated`,
            0xffaa00,
            fields
        );
        
        await this.sendToChannel(this.channels.orderUpdate, null, embed);
    }

    async logOrderComplete(user, order, shippingDetails) {
        const fields = [
            { name: '📋 Order', value: order.order_number, inline: true },
            { name: '💰 Total', value: `₹${order.total_amount}`, inline: true },
            { name: '👤 Customer', value: user.username, inline: true }
        ];
        
        const embed = this.createEmbed(
            '✅ Order Complete',
            `Order #${order.order_number} completed`,
            0x00ff00,
            fields
        );
        
        await this.sendToChannel(this.channels.orderComplete, null, embed);
    }

    // ==================== PAYMENT LOGS ====================

    async logPaymentInit(user, payment, orderDetails = {}) {
        const fields = [
            { name: '💰 Amount', value: `₹${payment.amount}`, inline: true },
            { name: '💳 Method', value: payment.payment_method, inline: true },
            { name: '🆔 Order ID', value: payment.order_id.toString(), inline: true },
            { name: '📞 Phone', value: orderDetails.phone || 'N/A', inline: true }
        ];
        
        const embed = this.createEmbed(
            '💳 Payment Initiated',
            `Payment for order #${payment.order_id}`,
            0xffaa00,
            fields
        );
        
        await this.sendToChannel(this.channels.paymentInit, null, embed);
    }

    async logPaymentSuccess(user, payment, proofUrl = null, upiTransactionId = null, orderDetails = {}) {
        const fields = [
            { name: '💰 Amount', value: `₹${payment.amount}`, inline: true },
            { name: '💳 Method', value: payment.payment_method, inline: true },
            { name: '👤 User', value: user.username, inline: true }
        ];
        
        if (upiTransactionId) {
            fields.push({ name: '🆔 UPI Txn ID', value: upiTransactionId, inline: false });
        }
        
        const embed = this.createEmbed(
            '✅ Payment Success',
            `Payment received for order #${payment.order_id}`,
            0x00ff00,
            fields
        );
        
        let message = `💰 Payment received for order #${payment.order_id}`;
        if (proofUrl) {
            message += `\nProof: ${proofUrl}`;
            const filePath = proofUrl.startsWith('/uploads/') ? path.join(__dirname, 'public', proofUrl) : null;
            if (filePath && fs.existsSync(filePath)) {
                await this.sendToChannel(this.channels.paymentSuccess, message, embed, filePath);
                return;
            }
        }
        
        await this.sendToChannel(this.channels.paymentSuccess, message, embed);
    }

    async logPaymentFailed(user, payment, reason, orderDetails = {}) {
        const fields = [
            { name: '💰 Amount', value: `₹${payment.amount}`, inline: true },
            { name: '❌ Reason', value: reason, inline: false }
        ];
        
        const embed = this.createEmbed(
            '❌ Payment Failed',
            `Payment failed for order #${payment.order_id}`,
            0xff0000,
            fields
        );
        
        await this.sendToChannel(this.channels.paymentFailed, null, embed);
    }

    // ==================== CART LOGS ====================

    async logCartAdd(user, product, quantity) {
        const fields = [
            { name: '👤 User', value: user.username, inline: true },
            { name: '📦 Product', value: product.name, inline: true },
            { name: '🔢 Quantity', value: quantity.toString(), inline: true }
        ];
        
        const embed = this.createEmbed(
            '🛒 Cart Add',
            `**${user.username}** added **${product.name}**`,
            0x00ff00,
            fields
        );
        
        await this.sendToChannel(this.channels.cartAdd, null, embed);
    }

    async logCartView(user) {
        const embed = this.createEmbed(
            '👀 Cart View',
            `**${user.username}** viewed cart`,
            0x3498db
        );
        
        await this.sendToChannel(this.channels.cartView, null, embed);
    }

    // ==================== PRODUCT LOGS ====================

    async logProductView(user, product) {
        const fields = [
            { name: '👤 User', value: user?.username || 'Guest', inline: true },
            { name: '📦 Product', value: product.name, inline: true },
            { name: '💰 Price', value: `₹${product.price}`, inline: true }
        ];
        
        const embed = this.createEmbed(
            '👀 Product View',
            `**${product.name}** viewed`,
            0x3498db,
            fields
        );
        
        await this.sendToChannel(this.channels.productView, null, embed);
    }

    async logProductAdd(admin, product) {
        const fields = [
            { name: '👤 Admin', value: admin.username, inline: true },
            { name: '📦 Product', value: product.name, inline: true },
            { name: '💰 Price', value: `₹${product.price}`, inline: true }
        ];
        
        const embed = this.createEmbed(
            '➕ Product Added',
            `**${product.name}** added by **${admin.username}**`,
            0x00ff00,
            fields
        );
        
        await this.sendToChannel(this.channels.productAdd, null, embed);
    }

    async logProductEdit(admin, product, changes) {
        const fields = [
            { name: '👤 Admin', value: admin.username, inline: true },
            { name: '📦 Product', value: product.name, inline: true },
            { name: '✏️ Changes', value: changes || 'Product updated', inline: false }
        ];
        
        const embed = this.createEmbed(
            '✏️ Product Edited',
            `**${product.name}** edited`,
            0xffaa00,
            fields
        );
        
        await this.sendToChannel(this.channels.productEdit, null, embed);
    }

    async logProductDelete(admin, product) {
        const fields = [
            { name: '👤 Admin', value: admin.username, inline: true },
            { name: '📦 Product', value: product.name, inline: true }
        ];
        
        const embed = this.createEmbed(
            '🗑️ Product Deleted',
            `**${product.name}** deleted`,
            0xff0000,
            fields
        );
        
        await this.sendToChannel(this.channels.productDelete, null, embed);
    }

    // ==================== ADMIN LOGS ====================

    async logAdminLogin(admin) {
        const embed = this.createEmbed(
            '👑 Admin Login',
            `**${admin.username}** logged into admin panel`,
            0xffaa00
        );
        
        await this.sendToChannel(this.channels.adminLogin, null, embed);
    }

    async logAdminAction(admin, action, details) {
        const fields = [
            { name: '⚡ Action', value: action, inline: true },
            { name: '📝 Details', value: details, inline: false }
        ];
        
        const embed = this.createEmbed(
            '⚡ Admin Action',
            `Action by **${admin.username}**`,
            0xffaa00,
            fields
        );
        
        await this.sendToChannel(this.channels.adminAction, null, embed);
    }

    // ==================== SYSTEM LOGS ====================

    async logError(error, context = {}) {
        console.error('Logging error to Discord:', error.message);
        
        const fields = [
            { name: '⚠️ Error', value: error.message || 'Unknown', inline: false },
            { name: '📍 Location', value: context.location || 'unknown', inline: true }
        ];
        
        const embed = this.createEmbed(
            '⚠️ System Error',
            'An error occurred',
            0xff0000,
            fields
        );
        
        await this.sendToChannel(this.channels.error, null, embed);
    }

    async logSystem(message, type = 'info') {
        const colors = {
            info: 0x3498db,
            success: 0x00ff00,
            warning: 0xffaa00,
            error: 0xff0000
        };
        
        const embed = this.createEmbed(
            '🔧 System',
            message,
            colors[type] || 0x3498db
        );
        
        if (this.ready) {
            await this.sendToChannel(this.channels.system, null, embed);
        } else {
            this.messageQueue.push({ channelId: this.channels.system, embed });
        }
        
        console.log(`[System/${type}] ${message}`);
    }

    async logBackup(admin, filename, size) {
        const fields = [
            { name: '👤 Admin', value: admin.username, inline: true },
            { name: '📁 File', value: filename, inline: true },
            { name: '📊 Size', value: `${(size / 1024).toFixed(2)} KB`, inline: true }
        ];
        
        const embed = this.createEmbed(
            '💾 Backup Created',
            `Backup by **${admin.username}**`,
            0x00ff00,
            fields
        );
        
        await this.sendToChannel(this.channels.backup, null, embed);
    }

    // ==================== UTILITY METHODS ====================

    getStatus() {
        return {
            ready: this.ready,
            user: this.client.user ? {
                tag: this.client.user.tag,
                id: this.client.user.id
            } : null,
            guilds: this.client.guilds.cache.size,
            reconnectAttempts: this.reconnectAttempts,
            queuedMessages: this.messageQueue.length
        };
    }
}

module.exports = new DiscordLogger();
