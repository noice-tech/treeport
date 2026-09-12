import http from 'node:http'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { TreeportService } from './service'
import {
  databases,
  fixture,
  integrationService,
  services,
  TerminalHostDouble
} from './service.integration-fixture'

describe('operation recovery', () => {
  it('replays a tree creation that had not started before restart', async () => {
    const { main, runner, service, database, config } = await fixture()
    const project = await service.registerProject(main)
    const operationId = 'op_pending_create'
    const timestamp = new Date().toISOString()
    await database.db.run(sql`
      INSERT INTO operations(
        id,kind,project_id,worktree_id,status,request_json,result_json,error,
        created_at,updated_at
      ) VALUES(
        ${operationId},'create',${project.id},NULL,'pending',
        ${JSON.stringify({ name: 'recovered-tree', base: 'default' })},
        NULL,NULL,${timestamp},${timestamp}
      )
    `)

    services.splice(services.indexOf(service), 1)
    await service.disposeRuntime()
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const restartedService = integrationService(
      new TreeportService({
        config,
        runner,
        terminalHost: new TerminalHostDouble(runner)
      })
    )
    services.push(restartedService)
    await restartedService.runEffect(restartedService.initialize())
    restartedService.attachHttpServer(http.createServer())

    let operation = await restartedService.getOperation(operationId)
    for (
      let attempt = 0;
      attempt < 100 &&
      (operation.status === 'pending' || operation.status === 'running');
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      operation = await restartedService.getOperation(operationId)
    }

    expect(operation).toMatchObject({
      id: operationId,
      kind: 'create',
      status: 'completed',
      result: { worktreeId: expect.any(String) }
    })
    expect(
      (await restartedService.getProjectSnapshot(project.id)).worktrees
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'recovered-tree', kind: 'linked' })
      ])
    )
  })
})
