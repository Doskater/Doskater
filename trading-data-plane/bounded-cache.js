export function createBoundedCache({ maxEntries = 16 } = {}) {
  const limit=Number(maxEntries);
  if(!Number.isInteger(limit)||limit<1) throw new Error('invalid_max_entries');
  const entries=new Map();
  return {
    get size(){ return entries.size; },
    get(key){ return entries.get(key); },
    set(key,value){
      if(entries.has(key)) entries.delete(key);
      entries.set(key,value);
      while(entries.size>limit) entries.delete(entries.keys().next().value);
      return this;
    },
    has(key){ return entries.has(key); },
    delete(key){ return entries.delete(key); },
    clear(){ entries.clear(); }
  };
}
