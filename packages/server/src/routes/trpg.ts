import Router from '@koa/router'
import { highlight, characterDraft } from '../controllers/trpg'
export const trpgRoutes = new Router()
trpgRoutes.post('/api/plugins/trpg/highlight', highlight)
trpgRoutes.post('/api/plugins/trpg/character-draft', characterDraft)

import { prepare } from '../controllers/trpg-recap'
trpgRoutes.post('/api/plugins/trpg/recap', prepare)
