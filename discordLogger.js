const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

class DiscordLogger {
    constructor() {
        this.client = new Client({ 
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ] 
        });
        this.ready = false;
        this.messageQueue = [];
        
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
            orderComplete: process.env.DISCORD_ORDER_COMPLETE_CHANNEL,
            paymentInit: process.env.DISCORD_PAYMENT_INIT_CHANNEL,
            paymentSuccess: process.env.DISCORD_PAYMENT_SUCCESS_CHANNEL,
            paymentFailed: process.env.DISCORD_PAYMENT_FAILED_CHANNEL,
            adminLogin: process.env.DISCORD_ADMIN_LOGIN_CHANNEL,
            adminAction: process.env.DISCORD_ADMIN_ACTION_CHANNEL,
            error: process.env.DISCORD_ERROR_CHANNEL,
            system: process.env.DISCORD_SYSTEM_CHANNEL,
            backup: process.env.DISCORD_BACKUP_CHANNEL
        };

        this.init();
    }

    async init() {
        try {
            this.client.on('ready', () => {
                console.log(`✅ Discord bot connected`);
                this.ready = true;
                this.processQueue();
            });

            this.client.on('error', (error) => {
                console.error('❌ Discord error:', error.message);
            });

            if (!process.env.DISCORD_BOT_TOKEN) {
                throw new Error('DISCORD_BOT_TOKEN missing');
            }

            await this.client.login(process.env.DISCORD_BOT_TOKEN);
        } catch (error) {
            console.error('❌ Discord init failed:', error.message);
        }
    }

    async processQueue() {
        while (this.messageQueue.length > 0) {
            const { channelId, message, embed, file } = this.messageQueue.shift();
            await this.sendToChannel(channelId, message, embed, file);
        }
    }

    async sendToChannel(channelId, message, embed = null, file = null) {
        if (!this.ready) {
            this.messageQueue.push({ channelId, message, embed, file });
            return;
        }

        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel) return;

            const content = { content: message, embeds: embed ? [embed] : [] };
            if (file && typeof file === 'string' && fs.existsSync(file)) {
                content.files = [file];
            }
            
            await channel.send(content);
        } catch (error) {
            console.error(`❌ Discord send error:`, error.message);
        }
    }

    createEmbed(title, description, color = 0x00ff00, fields = []) {
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();
        
        if (fields.length) embed.addFields(fields);
        return embed;
    }

    async logLogin(user, ip) {
        const embed = this.createEmbed('🔐 Login', `${user.username} logged in`, 0x00ff00, [
            { name: 'User', value: user.username, inline: true },
            { name: 'IP', value: ip || 'Unknown', inline: true }
        ]);
        await this.sendToChannel(this.channels.login, '🔐 **Login**', embed);
    }

    async logRegister(user) {
        const embed = this.createEmbed('📝 New User', `${user.username} registered`, 0x00ff00, [
            { name: 'User', value: user.username, inline: true }
        ]);
        await this.sendToChannel(this.channels.register, '📝 **New User**', embed);
    }

    async logProductAdd(admin, product) {
        const embed = this.createEmbed('➕ Product Added', `By ${admin.username}`, 0x00ff00, [
            { name: 'Product', value: product.name, inline: true },
            { name: 'Price', value: `₹${product.price}`, inline: true }
        ]);
        await this.sendToChannel(this.channels.productAdd, '➕ **Product Added**', embed);
    }

    async logProductEdit(admin, product, changes) {
        const embed = this.createEmbed('✏️ Product Edited', `By ${admin.username}`, 0xffaa00, [
            { name: 'Product', value: product.name, inline: true }
        ]);
        await this.sendToChannel(this.channels.productEdit, '✏️ **Product Edited**', embed);
    }

    async logProductDelete(admin, product) {
        const embed = this.createEmbed('🗑️ Product Deleted', `By ${admin.username}`, 0xff0000, [
            { name: 'Product', value: product.name, inline: true }
        ]);
        await this.sendToChannel(this.channels.productDelete, '🗑️ **Product Deleted**', embed);
    }

    async logCartAdd(user, product, quantity) {
        const embed = this.createEmbed('🛒 Cart Add', `${user.username} added item`, 0x00ff00, [
            { name: 'Product', value: product.name, inline: true },
            { name: 'Qty', value: quantity.toString(), inline: true },
            { name: 'Total', value: `₹${product.price * quantity}`, inline: true }
        ]);
        await this.sendToChannel(this.channels.cartAdd, '🛒 **Cart Add**', embed);
    }

    async logCartView(user) {
        const embed = this.createEmbed('👀 Cart View', `${user.username} viewed cart`, 0x3498db);
        await this.sendToChannel(this.channels.cartView, '👀 **Cart View**', embed);
    }

    async logOrderCreate(user, order) {
        const embed = this.createEmbed('📦 New Order', `Order by ${user.username}`, 0x00ff00, [
            { name: 'Order #', value: order.order_number, inline: true },
            { name: 'Amount', value: `₹${order.total_amount}`, inline: true },
            { name: 'Payment', value: order.payment_method, inline: true }
        ]);
        await this.sendToChannel(this.channels.orderCreate, '📦 **New Order**', embed);
    }

    async logOrderUpdate(user, order, oldStatus, newStatus) {
        const embed = this.createEmbed('🔄 Order Update', `Order ${order.order_number}`, 0xffaa00, [
            { name: 'Old', value: oldStatus, inline: true },
            { name: 'New', value: newStatus, inline: true }
        ]);
        await this.sendToChannel(this.channels.orderUpdate, '🔄 **Order Update**', embed);
    }

    async logOrderComplete(user, order) {
        const embed = this.createEmbed('✅ Order Complete', `Order ${order.order_number}`, 0x00ff00, [
            { name: 'Total', value: `₹${order.total_amount}`, inline: true }
        ]);
        await this.sendToChannel(this.channels.orderComplete, '✅ **Order Complete**', embed);
    }

    async logPaymentInit(user, payment) {
        const embed = this.createEmbed('💳 Payment Initiated', `By ${user.username}`, 0xffaa00, [
            { name: 'Amount', value: `₹${payment.amount}`, inline: true },
            { name: 'Method', value: payment.payment_method, inline: true }
        ]);
        await this.sendToChannel(this.channels.paymentInit, '💳 **Payment Initiated**', embed);
    }

    async logPaymentSuccess(user, payment, proofUrl = null) {
        const embed = this.createEmbed('✅ Payment Success', `By ${user.username}`, 0x00ff00, [
            { name: 'Amount', value: `₹${payment.amount}`, inline: true }
        ]);
        let message = `💰 **Payment Success**\n**User:** ${user.username}\n**Amount:** ₹${payment.amount}`;
        
        if (proofUrl) {
            message += `\n**Proof:** ${proofUrl}`;
            const filePath = proofUrl.startsWith('/uploads/') ? path.join(__dirname, 'public', proofUrl) : null;
            if (filePath && fs.existsSync(filePath)) {
                await this.sendToChannel(this.channels.paymentSuccess, message, embed, filePath);
                return;
            }
        }
        await this.sendToChannel(this.channels.paymentSuccess, message, embed);
    }

    async logPaymentFailed(user, payment, reason) {
        const embed = this.createEmbed('❌ Payment Failed', `For ${user.username}`, 0xff0000, [
            { name: 'Reason', value: reason, inline: false }
        ]);
        await this.sendToChannel(this.channels.paymentFailed, '❌ **Payment Failed**', embed);
    }

    async logAdminLogin(admin) {
        const embed = this.createEmbed('👑 Admin Login', `${admin.username} logged in`, 0xffaa00);
        await this.sendToChannel(this.channels.adminLogin, '👑 **Admin Login**', embed);
    }

    async logAdminAction(admin, action, details) {
        const embed = this.createEmbed('⚡ Admin Action', `By ${admin.username}`, 0xffaa00, [
            { name: 'Action', value: action, inline: true },
            { name: 'Details', value: details, inline: false }
        ]);
        await this.sendToChannel(this.channels.adminAction, '⚡ **Admin Action**', embed);
    }

    async logError(error, context = {}) {
        const embed = this.createEmbed('⚠️ Error', error.message || 'Unknown error', 0xff0000, [
            { name: 'Location', value: context.location || 'unknown', inline: false }
        ]);
        await this.sendToChannel(this.channels.error, '⚠️ **Error**', embed);
    }

    async logSystem(message, type = 'info') {
        const colors = { info: 0x3498db, success: 0x00ff00, error: 0xff0000 };
        const embed = this.createEmbed('🔧 System', message, colors[type] || 0x3498db);
        
        if (this.ready) {
            await this.sendToChannel(this.channels.system, '🔧 **System**', embed);
        } else {
            this.messageQueue.push({ channelId: this.channels.system, message: '🔧 **System**', embed });
        }
        console.log(`[System] ${message}`);
    }

    async logBackup(admin, filename, size) {
        const embed = this.createEmbed('💾 Backup', `By ${admin.username}`, 0x00ff00, [
            { name: 'File', value: filename, inline: true },
            { name: 'Size', value: `${(size / 1024).toFixed(2)} KB`, inline: true }
        ]);
        await this.sendToChannel(this.channels.backup, '💾 **Backup**', embed);
    }
}

module.exports = new DiscordLogger();
