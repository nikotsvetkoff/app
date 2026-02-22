-- CreateTable
CREATE TABLE "AdminRegistrationRequest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminRegistrationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminRegistrationRequest_email_key" ON "AdminRegistrationRequest"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRegistrationRequest_tokenHash_key" ON "AdminRegistrationRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminRegistrationRequest_expiresAt_idx" ON "AdminRegistrationRequest"("expiresAt");
