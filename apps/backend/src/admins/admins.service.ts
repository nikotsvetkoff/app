import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AdminListItem {
  id: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AdminsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listAdmins(): Promise<AdminListItem[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: {
        createdAt: 'asc'
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }));
  }
  async deleteAdmin(targetAdminId: string, currentAdminId: string): Promise<{ success: true }> {
    const exists = await this.prisma.user.findUnique({
      where: { id: targetAdminId },
      select: { id: true }
    });
    if (!exists) {
      throw new NotFoundException('Администратор не найден');
    }

    if (targetAdminId === currentAdminId) {
      throw new BadRequestException('Нельзя удалить собственную учетную запись администратора');
    }

    const totalAdmins = await this.prisma.user.count();
    if (totalAdmins <= 1) {
      throw new BadRequestException('Должен остаться минимум один администратор');
    }

    const [
      clientsCount,
      devicesCount,
      playlistSourcesCount,
      basePlaylistsCount,
      epgSourcesCount,
      ottProvidersCount,
      ottChannelsCount,
      ottProgramsCount
    ] = await Promise.all([
      this.prisma.client.count({
        where: { userId: targetAdminId }
      }),
      this.prisma.device.count({
        where: { userId: targetAdminId }
      }),
      this.prisma.playlistSource.count({
        where: { userId: targetAdminId }
      }),
      this.prisma.basePlaylist.count({
        where: { userId: targetAdminId }
      }),
      this.prisma.epgSource.count({
        where: { userId: targetAdminId }
      }),
      this.prisma.ottProvider.count({
        where: { userId: targetAdminId }
      }),
      this.prisma.ottChannel.count({
        where: { userId: targetAdminId }
      }),
      this.prisma.ottProgram.count({
        where: { userId: targetAdminId }
      })
    ]);

    if (
      clientsCount > 0 ||
      devicesCount > 0 ||
      playlistSourcesCount > 0 ||
      basePlaylistsCount > 0 ||
      epgSourcesCount > 0 ||
      ottProvidersCount > 0 ||
      ottChannelsCount > 0 ||
      ottProgramsCount > 0
    ) {
      throw new BadRequestException(
        'Нельзя удалить администратора с существующими клиентами, устройствами или источниками. Сначала очистите или перенесите данные.'
      );
    }

    await this.prisma.user.delete({
      where: { id: targetAdminId }
    });

    return { success: true };
  }
}

