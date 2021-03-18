import { Injectable } from '@angular/core';
import { Observable, Subject, BehaviorSubject, interval } from 'rxjs';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { environment } from '../environments/environment';
import { Router } from '@angular/router';
import {HttpClient} from '@angular/common/http';
import {normalizeFileReplacements} from '@angular-devkit/build-angular/src/utils';

export enum MessageType {
  CONTACTS_LIST = 'CONTACTS_LIST',
  CHAT_HISTORY = 'CHAT_HISTORY',
  NEW_CONTACT_REGISTERED = 'NEW_CONTACT_REGISTERED',
  USER_MESSAGE = 'USER_MESSAGE',
  PING = 'PING',
  PONG = 'PONG',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  AUTHENTICATE = 'AUTHENTICATE',
  REAUTHENTICATE = 'REAUTHENTICATE',
  SIGNUP = 'SIGNUP',
  LOGOFF = 'LOGOFF',
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  NOT_AUTHORIZED = 'NOT_AUTHORIZED'
}

export enum DestinationType {
  USER = 'USER',
  GROUP = 'GROUP',
  ALL_USERS_GROUP = 'ALL_USERS_GROUP'
}

export enum ContactType {
  USER = 'USER',
  GROUP = 'GROUP'
}

export enum ResponseStatus {
  SUCCESS = 'SUCCESS',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  INVALID_NAME = 'INVALID_NAME',
  INVALID_USERNAME = 'INVALID_USERNAME',
  INVALID_PASSWORD = 'INVALID_PASSWORD',
  SERVER_ERROR = 'SERVER_ERROR',
  USERNAME_IN_USE = 'USERNAME_IN_USE'
}

export interface SessionDetails {
  loggedIn: boolean;
  token: string;
  loggedInUser: any;
}

export interface RequestMessage {
  type: MessageType;
  seqId?: number;
  token?: string;
  payload?: any;
}

export interface ResponseMessage {
  type: MessageType;
  payload?: any;
}

export enum MimeType {
  TEXT = 'TEXT'
}

export interface ChatMessage {
  id?: string;
  from?: string;
  destinationType: DestinationType;
  destinationId: string;
  content: string;
  mimeType: MimeType;
  date?: Date;
}

export interface ScreenResolution {
  width: string;
  height: string;
  orientation: string;
}

export interface UserDeviceDetails {
  userIp: string;
  userAgent: string;
  screenResolution: ScreenResolution;
}

export interface LoginRequest {
  username: string;
  password: string;
  userDeviceDetails: UserDeviceDetails;
}

export interface LoginResponse {
  token: string;
  user: User;
  status: ResponseStatus;
  message?: string;
}

export interface SignupResponse {
  token: string;
  user: User;
  status: ResponseStatus;
}

export interface ChatHistoryRequest {
  destinationId: string;
}

export interface ChatHistoryResponse {
  destinationId: string;
  chatHistory: Array<ChatMessage>;
}

export interface User {
  id: string;
  name: string;
  description: string;
  contactType: ContactType;
  avatar: string;
}

export interface Contact {
  id: string;
  name: string;
  description: string;
  contactType: ContactType;
  avatar: string;
  chatHistory?: Array<ChatMessage>;
}

export enum ChatConnectionStatus {
  CONNECTING = 'Connecting...',
  RECONNECTING = 'Reconnecting...',
  ONLINE = 'Online',
  OFFLINE = 'Offline'
}

export const MOBILE_MAX_WIDTH = 450;

const pingMessage: RequestMessage = {
  type: MessageType.PING
};

const logoffMessage: RequestMessage = {
  type: MessageType.LOGOFF
};

const loggedOffSessionDetails: SessionDetails = {
  loggedIn: false,
  token: undefined,
  loggedInUser: undefined
};

const MAX_RECONNECTION_TRIES = 3;
const SESSION_KEY = 'session';

@Injectable({
  providedIn: 'root'
})
export class ChatService {

  private chatServerWebSocket: WebSocketSubject<any>;
  private contactsSubject: Subject<Array<Contact>> = new Subject<Array<Contact>>();
  private sessionDetailsSubject: BehaviorSubject<SessionDetails> = new BehaviorSubject<SessionDetails>(loggedOffSessionDetails);
  private loginSubject: Subject<LoginResponse> = new Subject();
  private signupSubject: Subject<SignupResponse> = new Subject();
  private messagesSubject: Subject<ChatMessage> = new Subject<ChatMessage>();
  private chatHistorySubject: Subject<ChatHistoryResponse> = new Subject<ChatHistoryResponse>();
  private connectionStatusSubject: BehaviorSubject<ChatConnectionStatus> = new BehaviorSubject<ChatConnectionStatus>(ChatConnectionStatus.OFFLINE);
  private sessionDetails: SessionDetails;
  private localStorage: Storage;
  private reconnectionTries = 0;
  private chatConnectionStatus: ChatConnectionStatus;

  constructor(private router: Router, private httpClient: HttpClient) {
    this.localStorage = window.localStorage;
    this.openWebSocketConnection();
  }

  /* Web Socket Connection  */

  private openWebSocketConnection(): void {
    this.loadSession();
    this.updateConnectionStatus(ChatConnectionStatus.CONNECTING);
    this.sessionDetailsSubject.next(this.sessionDetails);
    this.chatServerWebSocket = webSocket<ResponseMessage>(`${environment.backendUrl}`);
    this.listenWebSocketMessages();

    if (this.sessionDetails?.token !== undefined) {
      this.restoreSession();
    }

    this.playPingPong();
  }

  private listenWebSocketMessages(): void {

    this.chatServerWebSocket.asObservable()
      .subscribe(responseMessage => {

          const messagePayload = responseMessage.payload;

          if (responseMessage.type === MessageType.USER_MESSAGE) {
            this.messagesSubject.next(messagePayload);
          } else if (responseMessage.type === MessageType.CHAT_HISTORY) {
            this.chatHistorySubject.next(messagePayload);
          } else if (responseMessage.type === MessageType.CONTACTS_LIST || responseMessage.type === MessageType.NEW_CONTACT_REGISTERED) {
            this.contactsSubject.next(this.formatContacts(messagePayload));
          } else if (responseMessage.type === MessageType.AUTHENTICATE) {
            this.loginSubject.next(messagePayload);
          } else if (responseMessage.type === MessageType.SIGNUP) {
            this.signupSubject.next(messagePayload);
          } else if (responseMessage.type === MessageType.NOT_AUTHENTICATED) {
            this.unauthorizedOrClosed();
          }

          this.updateConnectionStatus(ChatConnectionStatus.ONLINE);
        },
        (error) => {
          this.tryReconnectWebSocketConnection();
        });

  }

  private sendWebsocketMessage(message: RequestMessage): Observable<RequestMessage> {
    return new Observable(subscriber => {
      if (this.chatConnectionStatus !== ChatConnectionStatus.ONLINE) {
        this.reconnectionTries = 0;
        this.tryReconnectWebSocketConnection();
        subscriber.error(new Error('Connection is closed.'));
      } else {
        this.chatServerWebSocket.next(message);
        subscriber.next(message);
        subscriber.complete();
      }
    });
  }

  private tryReconnectWebSocketConnection(): void {

    this.updateConnectionStatus(ChatConnectionStatus.OFFLINE);

    if (this.reconnectionTries < MAX_RECONNECTION_TRIES) {

      this.updateConnectionStatus(ChatConnectionStatus.RECONNECTING);
      this.reconnectionTries = this.reconnectionTries + 1;
      console.error(`trying to reconnect (${this.reconnectionTries}/${MAX_RECONNECTION_TRIES})`);

      this.closeWebsocketConnection();
      this.openWebSocketConnection();

    }

  }

  private closeWebsocketConnection(): void {
    this.chatServerWebSocket.complete();
  }

  private updateConnectionStatus(status: ChatConnectionStatus): void {

    this.chatConnectionStatus = status;

    switch (status) {
      case ChatConnectionStatus.ONLINE:
        this.reconnectionTries = 0;
        this.connectionStatusSubject.next(this.chatConnectionStatus);
        break;
      case ChatConnectionStatus.CONNECTING:
        this.connectionStatusSubject.next(this.chatConnectionStatus);
        break;
      case ChatConnectionStatus.RECONNECTING:
        this.connectionStatusSubject.next(this.chatConnectionStatus);
        break;
      case ChatConnectionStatus.OFFLINE:
        this.connectionStatusSubject.next(this.chatConnectionStatus);
        this.connectionStatusSubject.error(new Error('offline'));
        break;
    }

  }

  /* Web Socket Connection  */

  private loadSession(): void {

    const sessionJson: string = this.localStorage.getItem(SESSION_KEY);

    this.sessionDetails = (sessionJson !== undefined)
      ? JSON.parse(sessionJson)
      : loggedOffSessionDetails;

    this.sessionDetailsSubject.next(this.sessionDetails);
  }

  private restoreSession(): void {

    const restoreSessionRequest: RequestMessage = {
      type: MessageType.REAUTHENTICATE,
      payload: {
        token: this.sessionDetails.token
      }
    };

    this.chatServerWebSocket.next(restoreSessionRequest);
  }

  isLoggedIn(): boolean {
    return this.sessionDetails?.loggedIn;
  }

  login(loginRequest: LoginRequest): Observable<LoginResponse> {

    const authenticateRequest: RequestMessage = {
      type: MessageType.AUTHENTICATE,
      payload: loginRequest
    };

    this.chatServerWebSocket.next(authenticateRequest);
    return this.loginSubject;
  }

  signup(name: string, username: string, password: string): Observable<SignupResponse> {

    const authenticateRequest: RequestMessage = {
      type: MessageType.SIGNUP,
      payload: {
        name,
        username,
        password
      }
    };

    this.chatServerWebSocket.next(authenticateRequest);
    return this.signupSubject;
  }

  sendMessage(message: string, destinationContact: Contact): Observable<RequestMessage> {

    const destinationType = (destinationContact.contactType === ContactType.USER)
      ? DestinationType.USER
      : DestinationType.ALL_USERS_GROUP;

    const chatMessage: ChatMessage = {
      from: this.sessionDetails.loggedInUser.id,
      destinationType,
      destinationId: destinationContact.id,
      content: message,
      mimeType: MimeType.TEXT,
      date: new Date()
    };

    const newMessage: RequestMessage = {
      type: MessageType.USER_MESSAGE,
      token: this.sessionDetails.token,
      payload: chatMessage
    };

    return this.sendWebsocketMessage(newMessage);
  }

  requestChatHistory(destinationContact: Contact): void {

    const chatHistoryRequest: ChatHistoryRequest = {
      destinationId: destinationContact.id
    };

    const request: RequestMessage = {
      type: MessageType.CHAT_HISTORY,
      token: this.sessionDetails.token,
      payload: chatHistoryRequest
    };

    this.chatServerWebSocket.next(request);
  }

  requestContacts(): Observable<Array<Contact>> {
    const contactsRequestMessage: RequestMessage = {
      type: MessageType.CONTACTS_LIST,
      token: this.sessionDetails.token
    };

    this.chatServerWebSocket.next(contactsRequestMessage);
    return this.contactsSubject;
  }

  getIp(): Observable<any> {
    return this.httpClient.get('http://api.ipify.org/?format=json');
  }

  registerSession(session: SessionDetails): void {
    this.sessionDetails = session;
    this.localStorage.setItem(SESSION_KEY, JSON.stringify(this.sessionDetails));
    this.sessionDetailsSubject.next(this.sessionDetails);
  }

  logoff(): void {
    this.deregisterSession();
    this.closeWebsocketConnection();
    this.openWebSocketConnection();
  }

  deregisterSession(): void {
    this.chatServerWebSocket.next(logoffMessage);
    this.sessionDetails = loggedOffSessionDetails;
    this.localStorage.removeItem(SESSION_KEY);
    this.sessionDetailsSubject.next(this.sessionDetails);
    this.closeWebsocketConnection();
    this.openWebSocketConnection();
  }

  getConnectionStatusSubject(): Observable<ChatConnectionStatus> {
    return this.connectionStatusSubject;
  }

  getSessionDetailsObservable(): Observable<SessionDetails> {
    return this.sessionDetailsSubject;
  }

  getMessagesObservable(): Observable<ChatMessage> {
    return this.messagesSubject;
  }

  getChatHistoryObservable(): Observable<ChatHistoryResponse> {
    return this.chatHistorySubject;
  }

  private playPingPong(): void {
    interval(5000)
      .subscribe(val => {
        this.chatServerWebSocket.next(pingMessage);
      });
  }

  private unauthorizedOrClosed(): void {
    this.deregisterSession();
    this.router.navigate(['/login']);
  }

  private formatContacts(contacts: Array<Contact>): Array<Contact> {
    return contacts
      .map(contact => {
        contact.chatHistory = [];
        const splitName = contact.name.split(' ');

        contact.name = (splitName.length > 1)
          ? `${this.capitalize(splitName[0])} ${this.capitalize(splitName[splitName.length - 1])}`
          : `${this.capitalize(splitName[0])}`;

        return contact;
      });
  }

  private capitalize(data: string): string {
    return data.charAt(0).toUpperCase() + data.slice(1);
  }

}
