import express from 'express';
import asyncHandler from 'express-async-handler';
import { fhirDatastoreAccessProxyMiddleware } from '../middlewares/fhir-datastore-access-proxy';
import { mpiAccessProxyMiddleware } from '../middlewares/mpi-access-proxy';
import { mpiAuthMiddleware } from '../middlewares/mpi-auth';
import { mpiMdmEverythingMiddleware } from '../middlewares/mpi-mdm-everything';
import { matchAsyncHandler } from './handlers/matchPatientAsync';
import { matchSyncHandler } from './handlers/matchPatientSync';
import { mpiMdmQueryLinksMiddleware } from '../middlewares/mpi-mdm-query-links';
import { validationMiddleware } from '../middlewares/validation';
import { buildOpenhimResponseObject } from '../utils/utils';

const routes = express.Router();

const jsonBodyParser = express.json({ type: 'application/fhir+json' });

routes.post(
  '/fhir',
  jsonBodyParser,
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { status, transactionStatus, body } = res.locals.validationResponse;

    res.set('Content-Type', 'application/openhim+json');

    if (transactionStatus === 'Success') {
      const result = await matchSyncHandler(req.body);

      res.status(result.status).send(result.body);
    } else {
      const responseBody = buildOpenhimResponseObject(transactionStatus, status, body);

      res.status(status).send(responseBody);
    }
  })
);

routes.post(
  '/fhir/validate',
  jsonBodyParser,
  validationMiddleware,
  asyncHandler(async (_req, res) => {
    const { status, transactionStatus, body } = res.locals.validationResponse;

    const responseBody = buildOpenhimResponseObject(transactionStatus, status, body);

    res.set('Content-Type', 'application/openhim+json');
    res.status(status).send(responseBody);
  })
);

routes.post('/fhir/Patient', jsonBodyParser, validationMiddleware, mpiAccessProxyMiddleware);

routes.post('/fhir/Patient/\\$match', mpiAuthMiddleware, mpiAccessProxyMiddleware);

routes.get(
  '/fhir/Patient/:patientId/\\$everything',
  mpiMdmEverythingMiddleware,
  fhirDatastoreAccessProxyMiddleware
);

routes.post(
  '/async/fhir',
  jsonBodyParser,
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { status, transactionStatus, body } = res.locals.validationResponse;

    res.set('Content-Type', 'application/openhim+json');

    if (transactionStatus === 'Success') {
      const result = await matchAsyncHandler(req.body);

      res.status(result.status).send(result.body);
    } else {
      const responseBody = buildOpenhimResponseObject(transactionStatus, status, body);

      res.status(status).send(responseBody);
    }
  })
);

routes.get(
  /^\/fhir\/[A-z]+(\/.+)?$/,
  mpiMdmQueryLinksMiddleware,
  fhirDatastoreAccessProxyMiddleware
);

export default routes;
