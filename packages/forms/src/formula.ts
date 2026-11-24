/**
 * The small rule language for checks: numbers, names (with `.` for parts of a
 * value, e.g. `temp2h.temp`), + - * / ^, parentheses, comparisons
 * (== != < <= > >=), `and`, `or`, and the functions ceil, floor, round, abs,
 * min, max, sqrt; `pi` is π. No other code runs.
 *
 * `==` and `!=` allow for rounding on the form: within `tolerance`, or 1% of the
 * larger side.
 */

type Tok = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_.]*)|(==|!=|<=|>=|[-+*/^(),<>]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`Can't read the rule at "${src.slice(i)}"`);
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'name', v: m[2] });
    else out.push({ t: 'op', v: m[3] });
    i = re.lastIndex;
  }
  return out;
}

export type Node =
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; f: string; args: Node[] };

const FUNCS: Record<string, (...a: number[]) => number> = {
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
};

/** Parse a rule (precedence: or < and < comparison < + - < * / < ^ < unary). */
export function parseRule(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v;
  const isWord = (v: string) => peek()?.t === 'name' && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}" in "${src}"`);
    p++;
  };

  const or = (): Node => {
    let a = and();
    while (isWord('or')) {
      p++;
      a = { k: 'bin', op: 'or', a, b: and() };
    }
    return a;
  };
  const and = (): Node => {
    let a = cmp();
    while (isWord('and')) {
      p++;
      a = { k: 'bin', op: 'and', a, b: cmp() };
    }
    return a;
  };
  const cmp = (): Node => {
    const a = add();
    const t = peek();
    if (t?.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      p++;
      return { k: 'bin', op: t.v, a, b: add() };
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].v as string;
      a = { k: 'bin', op, a, b: mul() };
    }
    return a;
  };
  const mul = (): Node => {
    let a = pow();
    while (isOp('*') || isOp('/')) {
      const op = toks[p++].v as string;
      a = { k: 'bin', op, a, b: pow() };
    }
    return a;
  };
  const pow = (): Node => {
    const a = unary();
    if (isOp('^')) {
      p++;
      return { k: 'bin', op: '^', a, b: pow() };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      p++;
      return { k: 'neg', a: unary() };
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return atom();
  };
  const atom = (): Node => {
    const t = peek();
    if (!t) throw new Error(`Rule ends too soon: "${src}"`);
    p++;
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = or();
      expect(')');
      return e;
    }
    if (t.t === 'name') {
      if (isOp('(')) {
        if (!FUNCS[t.v]) throw new Error(`Unknown function "${t.v}"`);
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) {
            p++;
            args.push(or());
          }
        }
        expect(')');
        return { k: 'call', f: t.v, args };
      }
      return { k: 'name', v: t.v };
    }
    throw new Error(`Unexpected "${t.v}" in "${src}"`);
  };

  const node = or();
  if (p < toks.length) throw new Error(`Unexpected "${String(toks[p].v)}" in "${src}"`);
  return node;
}

/** Every name a rule reads. */
export function namesIn(n: Node): string[] {
  switch (n.k) {
    case 'num':
      return [];
    case 'name':
      return n.v === 'pi' ? [] : [n.v];
    case 'neg':
      return namesIn(n.a);
    case 'bin':
      return [...namesIn(n.a), ...namesIn(n.b)];
    case 'call':
      return n.args.flatMap(namesIn);
  }
}

/** Thrown when a name has no value: the check is skipped, not failed. */
export class Missing extends Error {
  constructor(public readonly field: string) {
    super(`No value for ${field}`);
  }
}

const close = (a: number, b: number, tol?: number) => Math.abs(a - b) <= (tol ?? 0.01 * Math.max(Math.abs(a), Math.abs(b)) + 1e-9);

/** Evaluate; booleans come back as 1 and 0. */
export function evaluate(n: Node, lookup: (name: string) => number | null, tolerance?: number): number {
  const ev = (m: Node): number => {
    switch (m.k) {
      case 'num':
        return m.v;
      case 'name': {
        if (m.v === 'pi') return Math.PI;
        const v = lookup(m.v);
        if (v === null || Number.isNaN(v)) throw new Missing(m.v);
        return v;
      }
      case 'neg':
        return -ev(m.a);
      case 'call':
        return FUNCS[m.f](...m.args.map(ev));
      case 'bin': {
        if (m.op === 'and') return ev(m.a) && ev(m.b) ? 1 : 0;
        if (m.op === 'or') return ev(m.a) || ev(m.b) ? 1 : 0;
        const a = ev(m.a);
        const b = ev(m.b);
        switch (m.op) {
          case '+':
            return a + b;
          case '-':
            return a - b;
          case '*':
            return a * b;
          case '/':
            return a / b;
          case '^':
            return a ** b;
          case '==':
            return close(a, b, tolerance) ? 1 : 0;
          case '!=':
            return close(a, b, tolerance) ? 0 : 1;
          case '<':
            return a < b ? 1 : 0;
          case '<=':
            return a <= b ? 1 : 0;
          case '>':
            return a > b ? 1 : 0;
          case '>=':
            return a >= b ? 1 : 0;
        }
        throw new Error(`Unknown operator ${m.op}`);
      }
    }
  };
  return ev(n);
}
