// @ts-nocheck
import { Given, When, Then } from 'cucumber';
import { expect } from 'chai';
import rewire from 'rewire';
import supertest from 'supertest';
import fetch from 'node-fetch';

import { getConfig } from '../../../src/config/config';

const app = rewire('../../../src/index').__get__('app');
const config = getConfig();

let server: any, request: any, responseBody: any;

Given(
  'SanteMPI client registry service is up and running',
  async (): Promise<void> => {
    const response = await fetch(
      `${config.santeMpiProtocol}://${config.santeMpiHost}:${config.santeMpiPort}/auth`
    );
    expect(response.status).to.equal(200);
    server = app.listen(3003);
    request = supertest(server);
  }
);

When(
  'a post request without body was sent to get patients',
  async (): Promise<void> => {
    const response = await request
      .post('/fhir/Patient/$match')
      .set('Content-Type', 'application/fhir+json')
      .expect(200);

    responseBody = response.body;
  }
);

When(
  'a post request with body was sent to get patients',
  async (): Promise<void> => {
    const response = await request
      .post('/fhir/Patient/$match')
      .send({
        name: 'drake',
      })
      .set('Content-Type', 'application/fhir+json')
      .expect(200);

    responseBody = response.body;
  }
);

Then('a response should be sent back', (): void => {
  expect(responseBody.id).not.empty;
  server.close();
});
