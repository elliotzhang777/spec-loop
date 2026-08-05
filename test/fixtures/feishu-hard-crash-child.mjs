import { writeFile } from 'node:fs/promises'

import { processFeishuAction } from '../../dist/connectors/feishu-callback.js'
import { createLocalSpecLoopConfirmationController } from '../../dist/connectors/feishu-controller.js'

const [projectRoot, inboxId, marker] = process.argv.slice(2)
if (!projectRoot || !inboxId || !marker) process.exit(2)

const controller = createLocalSpecLoopConfirmationController(projectRoot)
await processFeishuAction(projectRoot, inboxId, {
  lookup: (commandId) => controller.lookup(commandId),
  async execute(command) {
    const result = await controller.execute(command)
    await writeFile(marker, JSON.stringify({ command_id: command.command_id, audit_id: 'audit_crash_recovery' }))
    process.exit(91)
    return result
  },
})
