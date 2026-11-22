import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { HttpUsersRepository } from './http-users.repository';
import { UserStatus } from '@rebecca/types';

describe('HttpUsersRepository', () => {
  let repository: HttpUsersRepository;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [HttpUsersRepository]
    });
    repository = TestBed.inject(HttpUsersRepository);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should fetch all users with pagination and search parameters', () => {
    repository.getAll({ page: 1, limit: 10, search: 'alice', sortBy: 'interactions', sortOrder: 'desc' }).subscribe((res) => {
      expect(res.data.length).toBe(4);
      expect(res.data[0].status).toBe(UserStatus.ACTIVE);
      expect(res.data[1].status).toBe(UserStatus.BLOCKED);
      expect(res.data[2].status).toBe(UserStatus.MUTED);
      expect(res.data[3].status).toBe(UserStatus.ACTIVE);
    });

    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/users') &&
      r.params.get('page') === '1' &&
      r.params.get('limit') === '10' &&
      r.params.get('search') === 'alice' &&
      r.params.get('sortBy') === 'interactions' &&
      r.params.get('sortOrder') === 'desc'
    );
    expect(req.request.method).toBe('GET');
    req.flush({
      data: [
        { id: 'u1', username: 'alice', status: 'ACTIVE' },
        { id: 'u2', username: 'bob', status: 'BLOCKED' },
        { id: 'u3', username: 'charlie', status: 'MUTED' },
        { id: 'u4', username: 'dave', status: null }
      ],
      meta: { totalItems: 4 }
    });
  });

  it('should fetch all users with undefined params', () => {
    repository.getAll().subscribe((res) => {
      expect(res.data).toEqual([]);
    });

    const req = httpMock.expectOne((r) => r.url.endsWith('/users'));
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('should fetch user by ID', () => {
    repository.getById('bob').subscribe((user) => {
      expect(user.username).toBe('bob');
      expect(user.status).toBe(UserStatus.BLOCKED);
    });

    const req = httpMock.expectOne((r) => r.url.endsWith('/users/bob') && r.method === 'GET');
    req.flush({ id: 'bob', username: 'bob', status: 'BLOCKED' });
  });

  it('should fetch paginated user conversations with page, limit, and sortOrder', () => {
    repository.getConversations('bob', { page: 2, limit: 20, sortOrder: 'desc' }).subscribe((res) => {
      expect(res.data.length).toBe(1);
      expect(res.meta.currentPage).toBe(2);
    });

    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/users/bob/conversations') &&
      r.params.get('page') === '2' &&
      r.params.get('limit') === '20' &&
      r.params.get('sortOrder') === 'desc'
    );
    expect(req.request.method).toBe('GET');
    req.flush({
      data: [{ role: 'user', text: 'Hi', time: '2026-11-20T00:00:00Z' }],
      meta: { totalItems: 21, totalPages: 2, currentPage: 2, limit: 20 }
    });
  });

  it('should update user memory via PUT request', () => {
    repository.updateMemory('alice', '{"interests":["ai"]}').subscribe();

    const req = httpMock.expectOne((r) => r.url.endsWith('/users/alice/memory') && r.method === 'PUT');
    expect(req.request.body).toEqual({ coreProfile: '{"interests":["ai"]}' });
    req.flush({ success: true });
  });

  it('should bulk update user status via PUT request', () => {
    repository.bulkUpdateStatus(['user1', 'user2'], UserStatus.BLOCKED).subscribe();

    const req = httpMock.expectOne((r) => r.url.endsWith('/users/status') && r.method === 'PUT');
    expect(req.request.body).toEqual({ ids: ['user1', 'user2'], status: UserStatus.BLOCKED });
    req.flush({ success: true });
  });
});
