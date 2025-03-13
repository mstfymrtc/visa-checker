import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Update } from 'telegraf/typings/core/types/typegram';
import type { VisaAppointment } from '../types';
import { config } from '../config/environment';

interface TelegramError {
  response?: {
    parameters?: {
      retry_after?: number;
    };
  };
}

/**
 * Telegram servis sınıfı
 * Telegram mesajlarının gönderilmesi ve bot yönetiminden sorumludur
 */
class TelegramService {
  private bot: Telegraf;
  private messageCount = 0;
  private lastReset = Date.now();
  private resetInterval?: ReturnType<typeof setInterval>;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.setupErrorHandler();
    this.startRateLimitReset();
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
  }

  /**
   * Bot hata yakalayıcısını ayarlar
   * Bot çalışırken oluşabilecek hataları yakalar ve loglar
   */
  private setupErrorHandler(): void {
    this.bot.catch((err: unknown, ctx: Context<Update>) => {
      console.error('Telegram bot hatası:', {
        error: err,
        updateType: ctx.updateType,
        chatId: ctx.chat?.id
      });
    });
  }

  /**
   * Rate limit sayacını sıfırlar
   * Her dakika başında çalışır
   */
  private startRateLimitReset(): void {
    // Önceki interval'i temizle
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
    }

    this.resetInterval = setInterval(() => {
      if (this.messageCount > 0) {
        console.log(`Rate limit sayacı sıfırlandı. Önceki mesaj sayısı: ${this.messageCount}`);
      }
      this.messageCount = 0;
      this.lastReset = Date.now();
    }, 60000); // Her dakika
  }

  /**
   * Rate limit kontrolü yapar ve gerekirse bekler
   */
  private async handleRateLimit(): Promise<void> {
    if (this.messageCount >= config.telegram.rateLimit) {
      const timeToWait = 60000 - (Date.now() - this.lastReset);
      if (timeToWait > 0) {
        console.log(`Rate limit aşıldı. ${Math.ceil(timeToWait / 1000)} saniye bekleniyor...`);
        await new Promise(resolve => setTimeout(resolve, timeToWait));
        this.messageCount = 0;
        this.lastReset = Date.now();
      }
    }
  }

  /**
   * Randevu bilgilerini okunabilir bir mesaj formatına dönüştürür
   */
  formatMessage(appointment: VisaAppointment): string {
    const appointmentDate = appointment.appointment_date ? new Date(appointment.appointment_date) : null;
    const lastChecked = new Date(appointment.last_checked);

    const formatDate = (date: Date) => {
      return date.toLocaleString('tr-TR', {
        timeZone: 'Europe/Istanbul',
        dateStyle: 'medium',
        timeStyle: 'medium'
      });
    };

    return [
      '*🎯 YENİ VİZE RANDEVUSU BULUNDU\\!*\n',
      `🏛️ *Konsolosluk:* ${this.escapeMarkdown(appointment.center_name)}`,
      `📆 *Randevu Tarihi:* ${appointmentDate ? this.escapeMarkdown(appointmentDate.toLocaleDateString('tr-TR')) : '❌ Müsait değil'}`,
      `🛂 *Vize Kategorisi:* ${this.escapeMarkdown(appointment.visa_category)}${appointment.visa_subcategory ? `\n└ 📋 *Alt Kategori:* ${this.escapeMarkdown(appointment.visa_subcategory)}` : ''}`,
      `👥 *Bekleyen Kişi Sayısı:* ${appointment.people_looking}`,
      `\n🔗 *Randevu Almak İçin:*\n[Randevu Sistemine Git](${this.escapeMarkdown(appointment.book_now_link)})\n`,
      `⏰ *Son Güncelleme:* ${this.escapeMarkdown(formatDate(lastChecked))}`
    ].join('\n');
  }

  /**
   * Yeni randevu bilgisini Telegram kanalına gönderir
   * @returns Mesaj başarıyla gönderildiyse true, hata oluştuysa false döner
   */
  async sendNotification(appointment: VisaAppointment): Promise<boolean> {
    try {
      await this.handleRateLimit();

      await this.bot.telegram.sendMessage(
        config.telegram.channelId,
        this.formatMessage(appointment),
        {
          parse_mode: 'MarkdownV2',
          link_preview_options: {
            is_disabled: true
          }
        }
      );

      this.messageCount++;
      return true;
    } catch (error) {
      if (this.isTelegramError(error)) {
        const retryAfter = error.response?.parameters?.retry_after;
        if (retryAfter) {
          const waitTime = retryAfter * 1000;
          console.log(`Telegram rate limit aşıldı. ${retryAfter} saniye bekleniyor...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return this.sendNotification(appointment);
        }
      }
      console.error('Telegram mesajı gönderilirken hata oluştu:', error);
      return false;
    }
  }

  /**
   * Hata nesnesinin Telegram hatası olup olmadığını kontrol eder
   */
  private isTelegramError(error: unknown): error is TelegramError {
    return (
      error !== null &&
      typeof error === 'object' &&
      'response' in error &&
      error.response !== null &&
      typeof error.response === 'object' &&
      'parameters' in error.response
    );
  }

  /**
   * Servis kapatılırken interval'i temizle
   */
  cleanup(): void {
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
    }
  }
}

export const telegramService = new TelegramService();