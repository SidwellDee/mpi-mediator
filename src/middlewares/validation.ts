import { RequestHandler } from 'express';
import { getConfig } from '../config/config';
import logger from '../logger';
import { RequestDetails } from '../types/request';
import { buildOpenhimResponseObject, isHttpStatusOk, sendRequest } from '../utils/utils';

const config = getConfig();

export const validationMiddleware: RequestHandler = async (req, res, next) => {
  logger.info('Validating Fhir Resources');

  const reqDetails: RequestDetails = {
    protocol: config.fhirDatastoreProtocol,
    host: config.fhirDatastoreHost,
    port: config.fhirDatastorePort,
    path: `/fhir/${req.body.resourceType}/$validate`,
    method: 'POST',
    headers: { contentType: 'application/fhir+json' },
    data: JSON.stringify(req.body),
  };

  const response = await sendRequest(reqDetails);

  let transactionStatus = 'Success';

  if (isHttpStatusOk(response.status)) {
    logger.info('Successfully validated bundle!');
  } else {
    logger.error(`Error in validating: ${JSON.stringify(response.body)}!`);
    transactionStatus = 'Failed';
  }

  const responseBody = buildOpenhimResponseObject(
    transactionStatus,
    response.status,
    response.body
  );

  res.locals.validationResponse = { status: response.status, body: responseBody };
  next();
};
