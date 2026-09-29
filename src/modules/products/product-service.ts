import { Cache } from '../../cache/cache';
import { CategoryVersions, GLOBAL_SCOPE } from '../../cache/category-versions';
import { Db } from '../../infra/db';
import { lockCategoriesShared } from '../../infra/locks';
import { Clock, PricingService } from '../../pricing/pricing-service';
import { recomputeProductIds } from '../../pricing/recompute-sql';
import { HttpError, notFound } from '../../http/errors';
import { getProduct, listProducts, ProductView, SortDir } from './product-repo';

export interface ListParams {
  categoryId?: string;
  sort: SortDir;
  limit: number;
  cursor?: string;
}

export interface ProductPage {
  items: ProductView[];
  nextCursor: string | null;
}

interface PdpEntry {
  catVer: number;
  data: ProductView;
}

export interface CacheTtls {
  listingSeconds: number;
  productSeconds: number;
}

const encodeCursor = (v: ProductView) =>
  Buffer.from(JSON.stringify({ p: v.effectivePriceMinor, i: v.id })).toString('base64url');

function decodeCursor(c: string): { price: number; id: string } {
  try {
    const { p, i } = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (Number.isInteger(p) && typeof i === 'string' && /^[0-9a-f-]{36}$/i.test(i)) return { price: p, id: i };
  } catch {
    /* fallthrough */
  }
  throw new HttpError(400, 'INVALID_CURSOR', 'cursor is malformed');
}

export class ProductService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly versions: CategoryVersions,
    private readonly pricing: PricingService,
    private readonly clock: Clock,
    private readonly ttl: CacheTtls,
  ) {}

  /**
   * Storefront listing. Key = category version + normalized query, so one version
   * bump after a flash-sale recompute retires every cached page of that category.
   * The version is read BEFORE the database: if a bump lands after our read, our
   * (older) result is filed under the old version and never served again.
   */
  async list(params: ListParams): Promise<ProductPage> {
    const scope = params.categoryId ?? GLOBAL_SCOPE;
    const [ver] = await this.versions.get([scope]);
    const load = async (): Promise<ProductPage> => {
      const items = await listProducts(this.db, {
        categoryId: params.categoryId,
        sort: params.sort,
        limit: params.limit,
        cursor: params.cursor ? decodeCursor(params.cursor) : undefined,
      });
      const last = items[items.length - 1];
      return { items, nextCursor: items.length === params.limit && last ? encodeCursor(last) : null };
    };
    if (ver === undefined || ver < 0) return load(); // Redis unavailable: serve from DB
    const key = `plp:${scope}:v${ver}:${params.sort}:${params.limit}:${params.cursor ?? ''}`;
    return this.cache.getOrLoad(key, this.ttl.listingSeconds, load);
  }

  /**
   * Highest-traffic endpoint. The cached entry is keyed by product id but STAMPED
   * with its category version, so a category-wide flash sale (which never touches
   * this key) still invalidates it. It is also treated as a miss once the price's
   * validity window has passed (promotion started/ended).
   */
  async get(id: string): Promise<ProductView> {
    const key = `pdp:${id}`;
    const cached = await this.cache.getJson<PdpEntry>(key);
    if (cached) {
      const [ver] = await this.versions.get([cached.data.categoryId]);
      if (ver === cached.catVer && ver >= 0 && this.stillValid(cached.data)) return cached.data;
    }
    return this.cache.singleFlight(key, async () => {
      const categoryId = cached?.data.categoryId ?? (await this.categoryOf(id));
      const [ver] = await this.versions.get([categoryId]);
      let view = await getProduct(this.db, id);
      if (!view) throw notFound('product');
      if (!this.stillValid(view)) {
        // A promotion started/ended and the sweeper hasn't reached this row yet:
        // fix this one row now rather than serve a wrong price.
        await recomputeProductIds(this.db, [id], this.clock.now());
        view = (await getProduct(this.db, id))!;
      }
      if (ver !== undefined && ver >= 0 && view.categoryId === categoryId) {
        await this.cache.setJson(key, { catVer: ver, data: view } satisfies PdpEntry, this.ttl.productSeconds);
      }
      return view;
    });
  }

  /**
   * New products are priced by the same resolver inside the same transaction, while
   * holding the category's shared lock — so a product added during an active flash
   * sale is discounted from its first read, and cannot race a sale being created.
   */
  async create(input: {
    sku: string;
    name: string;
    categoryId: string;
    basePriceMinor: number;
    stockQuantity: number;
  }): Promise<ProductView> {
    const category = await this.db.category.findUnique({ where: { id: input.categoryId } });
    if (!category) throw new HttpError(422, 'INVALID_REFERENCE', 'category does not exist');

    const product = await this.db.$transaction(async (tx) => {
      await lockCategoriesShared(tx, [input.categoryId]);
      const p = await tx.product.create({ data: input });
      await this.pricing.priceProductsInTx(tx, [p]);
      return p;
    });
    await this.versions.bump([product.categoryId]);
    return (await getProduct(this.db, product.id))!;
  }

  private stillValid(v: ProductView): boolean {
    return v.priceValidUntil === null || new Date(v.priceValidUntil).getTime() > this.clock.now().getTime();
  }

  private async categoryOf(id: string): Promise<string> {
    const p = await this.db.product.findUnique({ where: { id }, select: { categoryId: true } });
    if (!p) throw notFound('product');
    return p.categoryId;
  }
}
