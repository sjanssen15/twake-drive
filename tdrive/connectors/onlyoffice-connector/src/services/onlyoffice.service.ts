import axios from 'axios';
import { ONLY_OFFICE_SERVER, onlyOfficeConnectivityCheckPeriodMS } from '@config';
import { PolledThingieValue } from '@/lib/polled-thingie-value';
import logger from '@/lib/logger';
import * as Utils from '@/utils';

/** @see https://api.onlyoffice.com/editors/basic */
export enum ErrorCode {
  SUCCESS = 0,
  KEY_MISSING_OR_DOC_NOT_FOUND = 1,
  INVALID_CALLBACK_URL = 2,
  INTERNAL_SERVER_ERROR = 3,
  FORCE_SAVE_BUT_NO_CHANGES_TO_APPLY = 4,
  COMMAND_NOT_CORRECT = 5,
  INVALID_TOKEN = 6,
}
/** Return the name of the error code in the `ErrorCode` enum if recognised, or a descript string */
export const ErrorCodeFromValue = (value: number) => Utils.getKeyForValueSafe(value, ErrorCode, 'OnlyOffice.ErrorCode');

/** @see https://api.onlyoffice.com/editors/callback */
export namespace Callback {
  enum ActionType {
    USER_DISCONNECTED = 0,
    USER_CONNECTED = 1,
    USER_INITIATED_FORCE_SAVE = 2,
  }

  interface Action {
    type: ActionType;
    userid: string;
  }

  enum ForceSaveType {
    FROM_COMMAND_SERVICE = 0,
    FORCE_SAVE_BUTTON_CLICKED = 1,
    SERVER_TIMER = 2,
    FORM_SUBMITTED = 3,
  }

  export enum Status {
    BEING_EDITED = 1,
    /** `url` field present with this status */
    READY_FOR_SAVING = 2,
    /** `url` field present with this status */
    ERROR_SAVING = 3,
    CLOSED_WITHOUT_CHANGES = 4,
    /** `url` and `forcesavetype` fields present with this status */
    BEING_EDITED_BUT_IS_SAVED = 6,
    /** `url` and `forcesavetype` fields present with this status */
    ERROR_FORCE_SAVING = 7,
  }

  /** Parameters given to the callback by the editing service */
  export interface Parameters {
    key: string;
    status: Status;
    filetype?: string;
    forcesavetype?: ForceSaveType;
    url?: string;
    actions?: Action[];
    users?: string[];
  }
}

/** For error responses from the {@see CommandService} */
export class CommandError extends Error {
  constructor(public readonly errorCode: ErrorCode, req: any, res: any) {
    super(
      `OnlyOffice command service error ${ErrorCodeFromValue(errorCode)} (${errorCode}): Requested ${JSON.stringify(req)} got ${JSON.stringify(res)}`,
    );
  }
}

/**
 * Helpers to define the protocol of the OnlyOffice editor service command API
 * @see https://api.onlyoffice.com/editors/command/
 */
namespace CommandService {
  interface BaseResponse {
    error: ErrorCode;
  }
  interface SuccessResponse extends BaseResponse {
    error: ErrorCode.SUCCESS;
  }
  interface ErrorResponse extends BaseResponse {
    error: Exclude<ErrorCode, ErrorCode.SUCCESS>;
  }

  abstract class BaseRequest<TSuccessResponse extends SuccessResponse> {
    constructor(public readonly c: string) {}

    /** POST this OnlyOffice command, does not check the `error` field of the response */
    async postUnsafe(): Promise<ErrorResponse | TSuccessResponse> {
      logger.silly(`OnlyOffice command ${this.c} sent: ${JSON.stringify(this)}`);
      const result = await axios.post(Utils.joinURL([ONLY_OFFICE_SERVER, 'coauthoring/CommandService.ashx']), this);
      logger.info(`OnlyOffice command ${this.c} response: ${result.status}: ${JSON.stringify(result.data)}`);
      return result.data as ErrorResponse | TSuccessResponse;
    }

    /** POST this request, and return the result, or throws if the `errorCode` returned isn't `ErrorCode.SUCCESS` */
    async post(): Promise<TSuccessResponse> {
      const result = await this.postUnsafe();
      if (result.error === ErrorCode.SUCCESS) return result;
      throw new CommandError(result.error, this, result);
    }
  }

  export namespace Version {
    interface Response extends SuccessResponse {
      version: string;
    }
    export class Request extends BaseRequest<Response> {
      constructor() {
        super('version');
      }
    }
  }

  export namespace ForceSave {
    interface Response extends SuccessResponse {
      key: string;
    }
    export class Request extends BaseRequest<Response> {
      constructor(public readonly key: string, public readonly userdata: string = '') {
        super('forcesave');
      }
    }
  }

  export namespace GetForgotten {
    interface Response extends SuccessResponse {
      key: string;
      url: string;
    }
    export class Request extends BaseRequest<Response> {
      constructor(public readonly key: string) {
        super('getForgotten');
      }
    }
  }

  export namespace GetForgottenList {
    interface Response extends SuccessResponse {
      keys: string[];
    }
    export class Request extends BaseRequest<Response> {
      constructor() {
        super('getForgottenList');
      }
    }
  }

  export namespace DeleteForgotten {
    interface Response extends SuccessResponse {
      key: string;
    }
    export class Request extends BaseRequest<Response> {
      constructor(public readonly key: string) {
        super('deleteForgotten');
      }
    }
  }

  export namespace License {
    export interface Response extends SuccessResponse {
      // @see https://api.onlyoffice.com/editors/command/license
      license: object;
      server: object;
      quota: object;
    }
    export class Request extends BaseRequest<Response> {
      constructor() {
        super('license');
      }
    }
  }
}

/**
 * Exposed OnlyOffice command service
 * @see https://api.onlyoffice.com/editors/command/
 */
class OnlyOfficeService {
  private readonly poller: PolledThingieValue<CommandService.License.Response>;

  constructor() {
    this.poller = new PolledThingieValue(
      'Connect to Only Office',
      async () => {
        logger.info('Only Office license status');
        return await this.getLicense();
      },
      onlyOfficeConnectivityCheckPeriodMS,
    );
  }
  /** Get the latest Only Office licence status from polling. If the return is `undefined`
   * it probably means there is a connection issue contacting the OnlyOffice server
   * from the connector.
   */
  public getLatestLicence() {
    return this.poller.latest();
  }

  /**
   * Iterate over all the forgotten files as returned by OnlyOffice, call the processor for each..
   * @param processor Handler to process the forgotten file (available at `url`). If `true` is returned,
   * the file is deleted from the forgotten file list in OnlyOffice. If false is returned, the
   * same forgotten file will reappear in a future batch
   * @returns The number of files processed and deleted
   */
  public async processForgotten(processor: (key: string, url: string) => Promise<boolean>): Promise<number> {
    const forgottenFiles = await this.getForgottenList();
    if (forgottenFiles.length === 0) return 0;
    Utils.fisherYattesShuffleInPlace(forgottenFiles);
    logger.info(`Forgotten files found: ${forgottenFiles.length}`);
    let deleted = 0;
    for (const forgottenFileKey of forgottenFiles) {
      const forgottenFileURL = await this.getForgotten(forgottenFileKey);
      logger.info(`Forgotten file about to process: ${JSON.stringify(forgottenFileKey)}`, { url: forgottenFileURL });
      const shouldDelete = await processor(forgottenFileKey, forgottenFileURL);
      if (shouldDelete) {
        logger.info(`Forgotten file about to be deleted: ${JSON.stringify(forgottenFileKey)}`);
        await this.deleteForgotten(forgottenFileKey);
        deleted++;
      }
    }
    return deleted;
  }

  // Note that `async` is important in the functions below. While they avoid the overhead
  // of `await`, the `async` is still required to catch the throw in `.post()`

  /** Return the version string of OnlyOffice */
  async getVersion(): Promise<string> {
    return new CommandService.Version.Request().post().then(response => response.version);
  }
  /** Return the version string of OnlyOffice */
  async getLicense(): Promise<CommandService.License.Response> {
    //TODO: When typing the response more fully, don't return the response object itself as here
    return new CommandService.License.Request().post();
  }
  /** Force a save in the editing session key provided. `userdata` will be forwarded to the callback */
  async forceSave(key: string, userdata = ''): Promise<string> {
    return new CommandService.ForceSave.Request(key, userdata).post().then(response => response.key);
  }
  /** Return the keys of all forgotten documents in OnlyOffice's document editing service */
  async getForgottenList(): Promise<string[]> {
    return new CommandService.GetForgottenList.Request().post().then(response => response.keys);
  }
  /** Return the url of a forgotten document specified by its key in OnlyOffice's document editing service */
  async getForgotten(key: string): Promise<string> {
    return new CommandService.GetForgotten.Request(key).post().then(response => response.url);
  }
  /** Delete a forgotten document specified by its key in OnlyOffice's document editing service */
  async deleteForgotten(key: string): Promise<string> {
    return new CommandService.DeleteForgotten.Request(key).post().then(response => response.key);
  }
}

export default new OnlyOfficeService();
