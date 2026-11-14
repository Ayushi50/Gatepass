import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DownstreamError } from '../clients/clients';

/** Runs a downstream call and translates its failure into the right HTTP error for the browser. */
export async function relay<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof DownstreamError)) throw err;
    if (err.status === 400) throw new BadRequestException(err.message);
    if (err.status === 403) throw new ForbiddenException(err.message);
    if (err.status === 404) throw new NotFoundException(err.message);
    if (err.status === 409) throw new ConflictException(err.message);
    if (err.status === 422) throw new UnprocessableEntityException(err.message);
    if (err.status === 503)
      throw new ServiceUnavailableException('a backend service is unavailable');
    throw new BadGatewayException('unexpected response from a backend service');
  }
}
