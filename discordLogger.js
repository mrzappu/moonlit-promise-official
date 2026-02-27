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
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildPresences
            ] 
        });
        this.ready = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000; // 5 seconds
        this.messageQueue = []; // Queue messages until bot is ready
        
        this.channels = {
            login: process.env.DISCORD_LOGIN_CHANNEL,
            logout: process.env.DISCORD_LOGOUT_CHANNEL,
            register: process.env.DISCORD_REGISTER_CHANNEL,
            productView: process.env.DISCORD_PRODUCT_VIEW_CHANNEL,
            productAdd: process.env.DISCORD_PRODUCT_ADD_CHANNEL,
            productEdit: process.env.DISCORD_PRODUCT_EDIT_CHANNEL,
            productDelete: process.env.DISCORD_PRODUCT_DELETE_CHANNEL,
            cartAdd: process.env.DISCORD_CART_ADD_CHANNEL,
            cartRemove: process.env.DISCORD_CART_REMOVE_CHANNEL,
            cartView: process.env.DISCORD_CART_VIEW_CHANNEL,
            orderCreate: process.env.DISCORD_ORDER_CREATE_CHANNEL,
            orderUpdate: process.env.DISCORD_ORDER_UPDATE_CHANNEL,
            orderStatus: process.env.DISCORD_ORDER_STATUS_CHANNEL,
            orderComplete: process.env.DISCORD_ORDER_COMPLETE_CHANNEL,
            paymentInit: process.env.DISCORD_PAYMENT_INIT_CHANNEL,
            paymentSuccess: process.env.DISCORD_PAYMENT_SUCCESS_CHANNEL,
            paymentFailed: process.env.DISCORD_PAYMENT_FAILED_CHANNEL,
            paymentRefund: process.env.DISCORD_PAYMENT_REFUND_CHANNEL,
            adminLogin: process.env.DISCORD_ADMIN_LOGIN_CHANNEL,
            adminAction: process.env.DISCORD_ADMIN_ACTION_CHANNEL,
            adminProduct: process.env.DISCORD_ADMIN_PRODUCT_CHANNEL,
            error: process.env.DISCORD_ERROR_CHANNEL,
            system: process.env.DISCORD_SYSTEM_CHANNEL,
            backup: process.env.DISCORD_BACKUP_CHANNEL
        };

        this.init();
    }

    async init() {
        try {
            // Set up event handlers before logging in
            this.client.on('ready', () => {
                console.log(`✅ Discord bot connected as ${this.client.user.tag}`);
                console.log(`   Bot ID: ${this.client.user.id}`);
                console.log(`   Serving ${this.client.guilds.cache.size} guilds`);
                this.ready = true;
                this.reconnectAttempts = 0;
                
                // Process queued messages
                this.processQueue();
                
                // Log startup to system channel
                this.logSystem('Discord bot connected successfully', 'success');
            });

            this.client.on('error', (error) => {
                console.error('❌ Discord client error:', error);
                this.ready = false;
                
                // Log error to error channel (if ready)
                this.logError(error, { location: 'discord_client' });
            });

            this.client.on('disconnect', () => {
                console.log('⚠️ Discord bot disconnected');
                this.ready = false;
                this.reconnect();
            });

            this.client.on('reconnecting', () => {
                console.log('🔄 Discord bot reconnecting...');
            });

            this.client.on('warn', (warning) => {
                console.warn('⚠️ Discord client warning:', warning);
            });

            // Login with token
            if (!process.env.DISCORD_BOT_TOKEN) {
                throw new Error('DISCORD_BOT_TOKEN is not defined in environment variables');
            }

            await this.client.login(process.env.DISCORD_BOT_TOKEN);
            
        } catch (error) {
            console.error('❌ Failed to connect Discord logger:', error.message);
            this.ready = false;
            
            // Specific error handling
            if (error.code === 'TokenInvalid') {
                console.error('   → The bot token is invalid. Please reset it in Discord Developer Portal');
                console.error('   → Go to: https://discord.com/developers/applications');
            } else if (error.code === 'DISALLOWED_INTENTS') {
                console.error('   → Missing required intents. Enable them in Discord Developer Portal:');
                console.error('   → Go to Bot section → Privileged Gateway Intents');
            } else if (error.code === 'TOKEN_INVALID') {
                console.error('   → Token is malformed. Check for extra spaces or quotes');
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

        // Exponential backoff for next attempts
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000); // Max 30 seconds
    }

    // Process queued messages when bot becomes ready
    async processQueue() {
        if (this.messageQueue.length > 0) {
            console.log(`📨 Processing ${this.messageQueue.length} queued messages...`);
            
            for (const queued of this.messageQueue) {
                try {
                    await this.sendToChannel(queued.channelId, queued.message, queued.embed, queued.file);
                    // Small delay between messages to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    console.error('Error sending queued message:', error);
                }
            }
            
            this.messageQueue = [];
            console.log('✅ Queue processed');
        }
    }

    async sendToChannel(channelId, message, embed = null, file = null) {
        // If bot is not ready, queue the message
        if (!this.ready) {
            console.log(`📝 Queueing message (bot not ready): ${message.substring(0, 50)}...`);
            this.messageQueue.push({ channelId, message, embed, file });
            
            // If this is the first queued message and bot is initializing, log it
            if (this.messageQueue.length === 1) {
                console.log('⏳ Bot initializing - messages will be sent when ready');
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
                content: message,
                embeds: embed ? [embed] : []
            };
            
            if (file) {
                if (typeof file === 'string' && fs.existsSync(file)) {
                    content.files = [file];
                } else if (file.path && fs.existsSync(file.path)) {
                    content.files = [file.path];
                }
            }
            
            await channel.send(content);
        } catch (error) {
            console.error(`❌ Failed to send to Discord channel ${channelId}:`, error.message);
            
            // Specific error handling
            if (error.code === 10003) {
                console.error(`   → Channel ${channelId} does not exist or bot cannot access it`);
            } else if (error.code === 50001) {
                console.error(`   → Bot lacks permissions to send messages in channel ${channelId}`);
            }
        }
    }

    createEmbed(title, description, color = 0x00ff00, fields = [], footer = null) {
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp(new Date());
        
        if (fields && fields.length > 0) {
            embed.addFields(fields);
        }
        
        if (footer) {
            embed.setFooter({ text: footer });
        }
        
        return embed;
    }

    async logLogin(user, ip) {
        const embed = this.createEmbed(
            '🔐 User Login',
            `${user.username} (${user.discord_id}) logged in`,
            0x00ff00,
            [
                { name: 'User', value: user.username, inline: true },
                { name: 'Discord ID', value: user.discord_id, inline: true },
                { name: 'IP Address', value: ip || 'Unknown', inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: false }
            ]
        );
        await this.sendToChannel(this.channels.login, '🔐 **Login Event**', embed);
    }

    async logLogout(user) {
        const embed = this.createEmbed(
            '🚪 User Logout',
            `${user.username} logged out`,
            0xffaa00,
            [
                { name: 'User', value: user.username, inline: true },
                { name: 'Discord ID', value: user.discord_id, inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.logout, '🚪 **Logout Event**', embed);
    }

    async logRegister(user) {
        const embed = this.createEmbed(
            '📝 New Registration',
            `New user registered: ${user.username}`,
            0x00ff00,
            [
                { name: 'Username', value: user.username, inline: true },
                { name: 'Discord ID', value: user.discord_id, inline: true },
                { name: 'Joined', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.register, '📝 **New Registration**', embed);
    }

    async logProductView(user, product) {
        const embed = this.createEmbed(
            '👀 Product Viewed',
            `${user?.username || 'Guest'} viewed product: ${product.name}`,
            0x3498db,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Price', value: `₹${product.price}`, inline: true },
                { name: 'Product ID', value: product.id.toString(), inline: true },
                { name: 'User', value: user?.username || 'Guest', inline: true }
            ]
        );
        await this.sendToChannel(this.channels.productView, '👀 **Product View**', embed);
    }

    async logProductAdd(admin, product) {
        const embed = this.createEmbed(
            '➕ Product Added',
            `Product added by admin: ${admin.username}`,
            0x00ff00,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Price', value: `₹${product.price}`, inline: true },
                { name: 'Category', value: product.category, inline: true },
                { name: 'Stock', value: product.stock?.toString() || 'N/A', inline: true },
                { name: 'Admin', value: admin.username, inline: true },
                { name: 'Admin ID', value: admin.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.productAdd, '➕ **Product Added**', embed);
    }

    async logProductEdit(admin, product, changes) {
        const embed = this.createEmbed(
            '✏️ Product Edited',
            `Product edited by admin: ${admin.username}`,
            0xffaa00,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Product ID', value: product.id.toString(), inline: true },
                { name: 'Changes', value: changes || 'Details updated', inline: false },
                { name: 'Admin', value: admin.username, inline: true },
                { name: 'Admin ID', value: admin.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.productEdit, '✏️ **Product Edited**', embed);
    }

    async logProductDelete(admin, product) {
        const embed = this.createEmbed(
            '🗑️ Product Deleted',
            `Product deleted by admin: ${admin.username}`,
            0xff0000,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Product ID', value: product.id.toString(), inline: true },
                { name: 'Price', value: `₹${product.price}`, inline: true },
                { name: 'Admin', value: admin.username, inline: true },
                { name: 'Admin ID', value: admin.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.productDelete, '🗑️ **Product Deleted**', embed);
    }

    async logCartAdd(user, product, quantity) {
        const embed = this.createEmbed(
            '🛒 Item Added to Cart',
            `${user.username} added item to cart`,
            0x00ff00,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'Quantity', value: quantity.toString(), inline: true },
                { name: 'Price per unit', value: `₹${product.price}`, inline: true },
                { name: 'Total', value: `₹${product.price * quantity}`, inline: true },
                { name: 'User', value: user.username, inline: true },
                { name: 'User ID', value: user.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.cartAdd, '🛒 **Cart Addition**', embed);
    }

    async logCartRemove(user, product) {
        const embed = this.createEmbed(
            '❌ Item Removed from Cart',
            `${user.username} removed item from cart`,
            0xffaa00,
            [
                { name: 'Product', value: product.name, inline: true },
                { name: 'User', value: user.username, inline: true },
                { name: 'User ID', value: user.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.cartRemove, '❌ **Cart Removal**', embed);
    }

    async logCartView(user) {
        const embed = this.createEmbed(
            '👀 Cart Viewed',
            `${user.username} viewed their cart`,
            0x3498db,
            [
                { name: 'User', value: user.username, inline: true },
                { name: 'User ID', value: user.discord_id, inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.cartView, '👀 **Cart View**', embed);
    }

    async logOrderCreate(user, order) {
        const embed = this.createEmbed(
            '📦 New Order Created',
            `Order created by ${user.username}`,
            0x00ff00,
            [
                { name: 'Order Number', value: order.order_number, inline: true },
                { name: 'Amount', value: `₹${order.total_amount}`, inline: true },
                { name: 'Payment Method', value: order.payment_method, inline: true },
                { name: 'User', value: user.username, inline: true },
                { name: 'User ID', value: user.discord_id, inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.orderCreate, '📦 **New Order**', embed);
    }

    async logOrderUpdate(user, order, oldStatus, newStatus) {
        const embed = this.createEmbed(
            '🔄 Order Updated',
            `Order status changed`,
            0xffaa00,
            [
                { name: 'Order Number', value: order.order_number, inline: true },
                { name: 'Old Status', value: oldStatus, inline: true },
                { name: 'New Status', value: newStatus, inline: true },
                { name: 'Updated By', value: user.username, inline: true },
                { name: 'User ID', value: user.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.orderUpdate, '🔄 **Order Update**', embed);
    }

    async logOrderStatus(user, order, status) {
        const embed = this.createEmbed(
            '📊 Order Status Changed',
            `Order ${order.order_number} status: ${status}`,
            0x3498db,
            [
                { name: 'Order', value: order.order_number, inline: true },
                { name: 'Status', value: status, inline: true },
                { name: 'User', value: user.username, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.orderStatus, '📊 **Order Status**', embed);
    }

    async logOrderComplete(user, order) {
        const embed = this.createEmbed(
            '✅ Order Completed',
            `Order ${order.order_number} completed`,
            0x00ff00,
            [
                { name: 'Order', value: order.order_number, inline: true },
                { name: 'Total', value: `₹${order.total_amount}`, inline: true },
                { name: 'User', value: user.username, inline: true },
                { name: 'User ID', value: user.discord_id, inline: true },
                { name: 'Completed', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.orderComplete, '✅ **Order Complete**', embed);
    }

    async logPaymentInit(user, payment) {
        const embed = this.createEmbed(
            '💳 Payment Initiated',
            `Payment initiated by ${user.username}`,
            0xffaa00,
            [
                { name: 'Order ID', value: payment.order_id.toString(), inline: true },
                { name: 'Amount', value: `₹${payment.amount}`, inline: true },
                { name: 'Method', value: payment.payment_method, inline: true },
                { name: 'User', value: user.username, inline: true },
                { name: 'User ID', value: user.discord_id, inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.paymentInit, '💳 **Payment Initiated**', embed);
    }

    async logPaymentSuccess(user, payment, proofUrl = null, upiTransactionId = null) {
        const fields = [
            { name: 'Order ID', value: payment.order_id.toString(), inline: true },
            { name: 'Amount', value: `₹${payment.amount}`, inline: true },
            { name: 'Method', value: payment.payment_method, inline: true },
            { name: 'User', value: user.username, inline: true },
            { name: 'User ID', value: user.discord_id, inline: true },
            { name: 'Time', value: new Date().toLocaleString(), inline: false }
        ];
        
        if (upiTransactionId) {
            fields.push({ name: 'UPI Transaction ID', value: upiTransactionId, inline: false });
        }
        
        const embed = this.createEmbed(
            '✅ Payment Successful',
            `Payment completed by ${user.username}`,
            0x00ff00,
            fields
        );
        
        let message = `💰 **Payment Success**\n**User:** ${user.username} (${user.discord_id})\n**Amount:** ₹${payment.amount}\n**Method:** ${payment.payment_method}\n**Order:** ${payment.order_id}\n**Time:** ${new Date().toLocaleString()}`;
        
        if (upiTransactionId) {
            message += `\n**UPI Txn ID:** ${upiTransactionId}`;
        }
        
        // If there's a proof file, send it as an attachment
        if (proofUrl) {
            message += `\n**Proof:** ${proofUrl}`;
            
            // If proofUrl is a local file path, we can try to send it as an attachment
            try {
                const filePath = proofUrl.startsWith('/uploads/') ? 
                    path.join(__dirname, 'public', proofUrl) : null;
                
                if (filePath && fs.existsSync(filePath)) {
                    await this.sendToChannel(this.channels.paymentSuccess, message, embed, filePath);
                    return;
                }
            } catch (err) {
                console.error('Error attaching payment proof:', err);
            }
        }
        
        await this.sendToChannel(this.channels.paymentSuccess, message, embed);
    }

    async logPaymentFailed(user, payment, reason) {
        const embed = this.createEmbed(
            '❌ Payment Failed',
            `Payment failed for ${user.username}`,
            0xff0000,
            [
                { name: 'Order', value: payment.order_id.toString(), inline: true },
                { name: 'Amount', value: `₹${payment.amount}`, inline: true },
                { name: 'Method', value: payment.payment_method, inline: true },
                { name: 'Reason', value: reason, inline: false },
                { name: 'User', value: user.username, inline: true },
                { name: 'User ID', value: user.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.paymentFailed, '❌ **Payment Failed**', embed);
    }

    async logPaymentRefund(admin, payment, reason) {
        const embed = this.createEmbed(
            '💸 Payment Refunded',
            `Payment refunded by admin ${admin.username}`,
            0xffaa00,
            [
                { name: 'Order', value: payment.order_id.toString(), inline: true },
                { name: 'Amount', value: `₹${payment.amount}`, inline: true },
                { name: 'Reason', value: reason, inline: false },
                { name: 'Admin', value: admin.username, inline: true },
                { name: 'Admin ID', value: admin.discord_id, inline: true }
            ]
        );
        await this.sendToChannel(this.channels.paymentRefund, '💸 **Payment Refunded**', embed);
    }

    async logAdminLogin(admin) {
        const embed = this.createEmbed(
            '👑 Admin Login',
            `Admin ${admin.username} logged in`,
            0xffaa00,
            [
                { name: 'Admin', value: admin.username, inline: true },
                { name: 'Discord ID', value: admin.discord_id, inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.adminLogin, '👑 **Admin Login**', embed);
    }

    async logAdminAction(admin, action, details) {
        const embed = this.createEmbed(
            '⚡ Admin Action',
            `Admin action performed by ${admin.username}`,
            0xffaa00,
            [
                { name: 'Admin', value: admin.username, inline: true },
                { name: 'Admin ID', value: admin.discord_id, inline: true },
                { name: 'Action', value: action, inline: true },
                { name: 'Details', value: details, inline: false },
                { name: 'Time', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.adminAction, '⚡ **Admin Action**', embed);
    }

    async logError(error, context = {}) {
        console.error('Logging error to Discord:', error.message);
        
        const embed = this.createEmbed(
            '⚠️ System Error',
            `Error occurred in ${context.location || 'unknown'}`,
            0xff0000,
            [
                { name: 'Error', value: error.message || error.toString(), inline: false },
                { name: 'Stack', value: (error.stack || 'No stack').substring(0, 1000), inline: false },
                { name: 'Context', value: JSON.stringify(context, null, 2).substring(0, 500), inline: false }
            ]
        );
        await this.sendToChannel(this.channels.error, '⚠️ **Error Alert**', embed);
    }

    async logSystem(message, type = 'info') {
        const colors = {
            info: 0x3498db,
            warning: 0xffaa00,
            error: 0xff0000,
            success: 0x00ff00
        };
        
        const embed = this.createEmbed(
            '🔧 System Notification',
            message,
            colors[type] || 0x3498db,
            [],
            `Type: ${type}`
        );
        
        // Only send if bot is ready, otherwise queue
        if (this.ready) {
            await this.sendToChannel(this.channels.system, '🔧 **System**', embed);
        } else {
            console.log(`📝 Queueing system message (bot not ready): ${message}`);
            this.messageQueue.push({ 
                channelId: this.channels.system, 
                message: '🔧 **System**', 
                embed 
            });
        }
        
        // Always log to console
        console.log(`[System/${type}] ${message}`);
    }

    async logBackup(admin, filename, size) {
        const embed = this.createEmbed(
            '💾 Database Backup',
            `Backup created by ${admin.username}`,
            0x00ff00,
            [
                { name: 'Filename', value: filename, inline: true },
                { name: 'Size', value: `${(size / 1024).toFixed(2)} KB`, inline: true },
                { name: 'Admin', value: admin.username, inline: true },
                { name: 'Admin ID', value: admin.discord_id, inline: true },
                { name: 'Time', value: new Date().toLocaleString(), inline: true }
            ]
        );
        await this.sendToChannel(this.channels.backup, '💾 **Backup Created**', embed);
    }

    // Method to check bot status
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
