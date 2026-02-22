import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email: this.normalizeEmail(email) } });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  countAll() {
    return this.prisma.user.count();
  }

  create(email: string, passwordHash: string) {
    return this.prisma.user.create({
      data: {
        email: this.normalizeEmail(email),
        passwordHash
      }
    });
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
