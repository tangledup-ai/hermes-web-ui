import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/meeting-storage'

export const meetingStorageRoutes = new Router()

// Meeting metadata
meetingStorageRoutes.get('/api/meeting-storage/:meetingId', ctrl.getMeeting)
meetingStorageRoutes.put('/api/meeting-storage/:meetingId', ctrl.saveMeeting)
meetingStorageRoutes.delete('/api/meeting-storage/:meetingId', ctrl.deleteMeeting)
meetingStorageRoutes.get('/api/meeting-storage', ctrl.listMeetings)

// Audio
meetingStorageRoutes.post('/api/meeting-storage/:meetingId/audio', ctrl.uploadAudio)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/audio', ctrl.downloadAudio)

// Transcript
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/transcript', ctrl.saveTranscript)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/transcript', ctrl.getTranscript)

// JSON report
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/json', ctrl.saveJsonReport)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/json', ctrl.downloadJsonReport)

// HTML report
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/html', ctrl.saveHtmlReport)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/html', ctrl.downloadHtmlReport)

import * as recap from '../../controllers/trpg-recap'
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/recaps', recap.list)
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/recaps', recap.save)
meetingStorageRoutes.delete('/api/meeting-storage/:meetingId/recaps/:recapId', recap.remove)
