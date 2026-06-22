-- Slack member ID used to attribute Slack-driven actions to an ERP user.
ALTER TABLE "User" ADD COLUMN "slackUserId" TEXT;

-- One ERP user per Slack account.
CREATE UNIQUE INDEX "User_slackUserId_key" ON "User"("slackUserId");
