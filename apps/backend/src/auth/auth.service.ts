import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes, randomInt } from 'crypto';
import nodemailer from 'nodemailer';
import { Prisma } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ConfirmRegistrationDto } from './dto/confirm-registration.dto';
import type { ForgotPasswordDto } from './dto/forgot-password.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
import type { ResendRegistrationDto } from './dto/resend-registration.dto';

export interface AuthResult {
  accessToken: string;
  user: {
    id: string;
    email: string;
  };
}

export interface RegisterRequestResult {
  success: true;
  message: string;
  expiresAt: string;
}

export interface AuthActionResult {
  success: true;
  message: string;
}

@Injectable()
export class AuthService {
  private readonly registerTokenTtlMs: number;
  private readonly passwordResetTokenTtlMs: number;

  constructor(
    @Inject(UsersService) private readonly usersService: UsersService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {
    const ttlMin = Number(this.configService.get('ADMIN_REGISTER_TOKEN_TTL_MIN') ?? 30);
    this.registerTokenTtlMs = Math.max(5, ttlMin) * 60 * 1000;

    const resetTtlMin = Number(this.configService.get('ADMIN_PASSWORD_RESET_TOKEN_TTL_MIN') ?? 30);
    this.passwordResetTokenTtlMs = Math.max(5, resetTtlMin) * 60 * 1000;
  }

  async register(dto: RegisterDto): Promise<RegisterRequestResult> {
    const normalizedEmail = this.normalizeEmail(dto.email);
    const existing = await this.usersService.findByEmail(normalizedEmail);
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const passwordHash = await hash(dto.password, 10);
    const { token: confirmationCode, tokenHash } = await this.generateUniqueRegistrationCode();
    const expiresAt = new Date(Date.now() + this.registerTokenTtlMs);

    await this.prisma.adminRegistrationRequest.upsert({
      where: {
        email: normalizedEmail
      },
      update: {
        passwordHash,
        tokenHash,
        expiresAt
      },
      create: {
        email: normalizedEmail,
        passwordHash,
        tokenHash,
        expiresAt
      }
    });

    try {
      await this.sendRegistrationEmail(normalizedEmail, confirmationCode, expiresAt);
    } catch (error) {
      await this.prisma.adminRegistrationRequest
        .deleteMany({
          where: {
            email: normalizedEmail,
            tokenHash
          }
        })
        .catch(() => undefined);
      throw error;
    }

    return {
      success: true,
      message: 'Код подтверждения отправлен на email.',
      expiresAt: expiresAt.toISOString()
    };
  }

  async resendRegistration(dto: ResendRegistrationDto): Promise<RegisterRequestResult> {
    const normalizedEmail = this.normalizeEmail(dto.email);
    const existing = await this.usersService.findByEmail(normalizedEmail);
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const pending = await this.prisma.adminRegistrationRequest.findUnique({
      where: {
        email: normalizedEmail
      }
    });
    if (!pending) {
      throw new BadRequestException('Сначала отправьте первичную регистрацию.');
    }

    const { token: confirmationCode, tokenHash } = await this.generateUniqueRegistrationCode();
    const expiresAt = new Date(Date.now() + this.registerTokenTtlMs);

    await this.prisma.adminRegistrationRequest.update({
      where: {
        email: normalizedEmail
      },
      data: {
        tokenHash,
        expiresAt
      }
    });

    try {
      await this.sendRegistrationEmail(normalizedEmail, confirmationCode, expiresAt);
    } catch (error) {
      await this.prisma.adminRegistrationRequest
        .update({
          where: {
            email: normalizedEmail
          },
          data: {
            tokenHash: pending.tokenHash,
            expiresAt: pending.expiresAt
          }
        })
        .catch(() => undefined);
      throw error;
    }

    return {
      success: true,
      message: 'Код подтверждения отправлен повторно.',
      expiresAt: expiresAt.toISOString()
    };
  }

  async confirmRegistration(dto: ConfirmRegistrationDto): Promise<AuthResult> {
    const token = dto.token.trim();
    if (!token) {
      throw new BadRequestException('Confirmation token is required');
    }

    if (!/^\d{8}$/.test(token)) {
      throw new BadRequestException('Confirmation token is invalid');
    }

    const tokenHash = this.hashToken(token);
    const pending = await this.prisma.adminRegistrationRequest.findUnique({
      where: {
        tokenHash
      }
    });
    if (!pending) {
      throw new BadRequestException('Confirmation token is invalid');
    }

    if (pending.expiresAt.getTime() < Date.now()) {
      await this.prisma.adminRegistrationRequest
        .delete({
          where: {
            id: pending.id
          }
        })
        .catch(() => undefined);
      throw new BadRequestException('Confirmation token is expired');
    }

    const existingUser = await this.usersService.findByEmail(pending.email);
    if (existingUser) {
      await this.prisma.adminRegistrationRequest.deleteMany({
        where: {
          email: pending.email
        }
      });
      throw new ConflictException('Email already exists');
    }

    try {
      const user = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.user.create({
          data: {
            email: pending.email,
            passwordHash: pending.passwordHash
          }
        });

        await transaction.adminRegistrationRequest.deleteMany({
          where: {
            email: pending.email
          }
        });

        return created;
      });

      return this.buildResult(user.id, user.email);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email already exists');
      }
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildResult(user.id, user.email);
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<AuthActionResult> {
    const normalizedEmail = this.normalizeEmail(dto.email);
    const genericMessage = 'Если email существует, ссылка для восстановления уже отправлена.';
    const user = await this.usersService.findByEmail(normalizedEmail);

    if (!user) {
      return {
        success: true,
        message: genericMessage
      };
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + this.passwordResetTokenTtlMs);

    await this.prisma.passwordResetRequest.upsert({
      where: {
        userId: user.id
      },
      update: {
        tokenHash,
        expiresAt
      },
      create: {
        userId: user.id,
        tokenHash,
        expiresAt
      }
    });

    try {
      await this.sendPasswordResetEmail(user.email, token, expiresAt);
    } catch (error) {
      await this.prisma.passwordResetRequest
        .deleteMany({
          where: {
            userId: user.id,
            tokenHash
          }
        })
        .catch(() => undefined);
      throw error;
    }

    return {
      success: true,
      message: genericMessage
    };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<AuthActionResult> {
    const rawToken = dto.token.trim();
    if (!rawToken) {
      throw new BadRequestException('Reset token is required');
    }

    const tokenHash = this.hashToken(rawToken);
    const request = await this.prisma.passwordResetRequest.findUnique({
      where: {
        tokenHash
      }
    });

    if (!request) {
      throw new BadRequestException('Reset token is invalid');
    }

    if (request.expiresAt.getTime() < Date.now()) {
      await this.prisma.passwordResetRequest
        .delete({
          where: {
            id: request.id
          }
        })
        .catch(() => undefined);
      throw new BadRequestException('Reset token is expired');
    }

    const passwordHash = await hash(dto.password, 10);
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.user.update({
          where: {
            id: request.userId
          },
          data: {
            passwordHash
          }
        });

        await transaction.passwordResetRequest.deleteMany({
          where: {
            userId: request.userId
          }
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new BadRequestException('Reset token is invalid');
      }
      throw error;
    }

    return {
      success: true,
      message: 'Пароль обновлен. Теперь можно войти с новым паролем.'
    };
  }

  private async sendRegistrationEmail(email: string, token: string, expiresAt: Date): Promise<void> {
    const { transport, from } = this.createMailTransport();
    const confirmationCode = token;
    const expiresAtText = expiresAt.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    try {
      await transport.sendMail({
        from,
        to: email,
        subject: 'Код подтверждения AccountTV Admin',
        text: [
          'Вы запросили регистрацию администратора AccountTV.',
          `Код подтверждения: ${confirmationCode}`,
          `Срок действия кода: до ${expiresAtText}`,
          'Введите этот код в форме подтверждения регистрации.'
        ].join('\n'),
        html: [
          '<p>Вы запросили регистрацию администратора <strong>AccountTV</strong>.</p>',
          `<p>Код подтверждения: <strong style="font-size:22px;letter-spacing:2px;">${confirmationCode}</strong></p>`,
          `<p>Срок действия кода: <strong>до ${expiresAtText}</strong></p>`,
          '<p>Введите код в форме подтверждения регистрации.</p>'
        ].join('')
      });
    } catch {
      throw new ServiceUnavailableException('Unable to send confirmation email via SMTP');
    }
  }

  private async sendPasswordResetEmail(email: string, token: string, expiresAt: Date): Promise<void> {
    const { transport, from } = this.createMailTransport();
    const resetUrl = this.buildPasswordResetUrl(token);
    const expiresAtText = expiresAt.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    try {
      await transport.sendMail({
        from,
        to: email,
        subject: 'AccountTV password reset',
        text: [
          'Password reset was requested for your AccountTV admin account.',
          `Set a new password: ${resetUrl}`,
          `Token expires at: ${expiresAtText}`
        ].join('\n'),
        html: [
          '<p>Password reset was requested for your <strong>AccountTV</strong> admin account.</p>',
          `<p><a href="${resetUrl}">Set a new password</a></p>`,
          `<p>Token expires at: <strong>${expiresAtText}</strong></p>`
        ].join('')
      });
    } catch {
      throw new ServiceUnavailableException('Unable to send password reset email via SMTP');
    }
  }

  private createMailTransport(): { transport: nodemailer.Transporter; from: string } {
    const smtpUser = (this.configService.get<string>('SMTP_USER') ?? '').trim();
    const smtpPass = (this.configService.get<string>('SMTP_PASS') ?? '').trim();
    if (!smtpUser || !smtpPass) {
      throw new ServiceUnavailableException(
        'SMTP is not configured. Set SMTP_USER and SMTP_PASS (Gmail app password).'
      );
    }

    const transport = nodemailer.createTransport({
      host: (this.configService.get<string>('SMTP_HOST') ?? 'smtp.gmail.com').trim(),
      port: Number(this.configService.get<string>('SMTP_PORT') ?? 587),
      secure: (this.configService.get<string>('SMTP_SECURE') ?? 'false').trim().toLowerCase() === 'true',
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    const from = (this.configService.get<string>('SMTP_FROM') ?? smtpUser).trim();
    return { transport, from };
  }

  private async generateUniqueRegistrationCode(): Promise<{ token: string; tokenHash: string }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const token = this.generateRegistrationCode();
      const tokenHash = this.hashToken(token);

      const existing = await this.prisma.adminRegistrationRequest.findUnique({
        where: {
          tokenHash
        },
        select: {
          id: true
        }
      });

      if (!existing) {
        return { token, tokenHash };
      }
    }

    throw new ServiceUnavailableException('Unable to generate registration code. Please try again.');
  }

  private generateRegistrationCode(): string {
    return randomInt(0, 100_000_000)
      .toString()
      .padStart(8, '0');
  }

  private buildPasswordResetUrl(token: string): string {
    const baseUrlRaw = (
      this.configService.get<string>('ADMIN_RESET_PASSWORD_BASE_URL') ??
      this.configService.get<string>('ADMIN_CONFIRM_BASE_URL') ??
      'http://localhost:5175/'
    ).trim();

    let baseUrl: URL;
    try {
      baseUrl = new URL(baseUrlRaw);
    } catch {
      throw new ServiceUnavailableException('ADMIN_RESET_PASSWORD_BASE_URL is invalid');
    }

    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new ServiceUnavailableException('ADMIN_RESET_PASSWORD_BASE_URL must use http or https');
    }

    baseUrl.searchParams.set('resetToken', token);
    return baseUrl.toString();
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private async buildResult(id: string, email: string): Promise<AuthResult> {
    const accessToken = await this.jwtService.signAsync(
      {
        sub: id,
        email
      },
      {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: this.configService.get<string>('JWT_EXPIRES_IN') ?? '1d'
      }
    );

    return {
      accessToken,
      user: {
        id,
        email
      }
    };
  }
}
