class Serializer {
    static SER_UID_GEN = 0;
    REF_UID_GEN = 0;
    constructor(data) {
        this.SER_ID = "_SID" + Serializer.SER_UID_GEN++;
        
        this.refs = {};
        this.ref_counts = {};
        this.data = this.serializeStep(data);
    }
    serializeStep(obj) {
        if (typeof obj == "function")
            throw "Cannot serialize functions to JSON";
        
        // Can't do anything more with primitive types: just return them without any further processing
        if (obj === null || obj === undefined || typeof obj != "object")
            return obj;
        
        // This must be an object. First check whether it has already been serialized, and if so return the reference.
        if (obj[this.SER_ID]) {
            if (1 === this.ref_counts[obj[this.SER_ID]]++)
                this.refs[obj[this.SER_ID]]._r = obj[this.SER_ID];
            return { _r: obj[this.SER_ID] };
        }
        
        // Register this object as a reference
        Object.defineProperty(obj, this.SER_ID, {
            enumerable: false,
            configurable: false,
            writable: false,
            value: ++this.REF_UID_GEN
        });
        this.ref_counts[obj[this.SER_ID]] = 1;
        const ref = this.refs[obj[this.SER_ID]] = { _t: obj.constructor.name };
        
        // This object might have specified a serialize function.
        if (typeof obj.serialize == "function")
            ref._v = obj.serialize(this);
        
        // If this is an array, we can make a small performance savings with map over object enumeration.
        else if (obj instanceof Array)
            ref._v = obj.map(v => this.serializeStep(v));
        
        // This is a plain, vanilla object, serialize each key/val separately.
        else {
            ref._v = {};
            for (let [k,v] of Object.entries(obj))
                if (obj.hasOwnProperty(k) && k !== this.SER_ID)
                    ref._v[k] = this.serializeStep(v);
        }
        
        return ref;
    }
    plain() {
        return this.data;
    }
    toJSON() {
        return JSON.stringify(this.plain());
    }
    
    
    static deserializeJSON(json_txt) {
        return Serializer.deserializeData(JSON.parse(json_txt));
    }
    static deserializeData(json_data) {
        const deserialized_rs = {}, type_cache = {};
        return Serializer.deserializeStep(json_data, deserialized_rs, type_cache);
    }
    static deserializeStep(json_obj, deserialized_rs, type_cache) {
        // If this is a primitive type, no work to do, just return it.
        if (json_obj === null || json_obj === undefined || typeof json_obj != "object" || (!("_r" in json_obj) && !("_t" in json_obj)))
            return json_obj;
        
        // If this is a reference that should have already appeared in the deserialization, fetch it. If not, something has gone wrong.
        if ("_r" in json_obj && !("_t" in json_obj)) {
            if (!(json_obj._r in deserialized_rs))
                throw "Attempt to deserialize references out of order";
            return deserialized_rs[json_obj._r];
        }
        
        // First, we have to dereference any descendant properties contained in this object.
        let derefed = null, ret = null;
        if (json_obj._v instanceof Array)
            derefed = json_obj._v.map(v => Serializer.deserializeStep(v, deserialized_rs, type_cache));
        else {
            derefed = {};
            for (let [k,v] of Object.entries(json_obj._v))
            derefed[k] = Serializer.deserializeStep(v, deserialized_rs, type_cache);
        }
        
        // If this object is a plain object or array, we can then just use the derefed object.
        if (json_obj._t == "Object" || json_obj._t == "Array")
            ret = derefed;
        
        else {
            // Otherwise, we need to lookup the type with the given name, and figure out how it wants to deserialize objects.
            if (!(json_obj._t in type_cache)) {
                type_cache[json_obj._t] = eval(json_obj._t);
                if (!type_cache[json_obj._t])
                    throw "Unknown type " + json_obj._t;
            }
            
            // If this type defines an explicit deserialization function, use that.
            if ("deserialize" in type_cache[json_obj._t])
                ret = type_cache[json_obj._t].deserialize(derefed);
            
            // Otherwise, manually create an object of the given type, with the specified properties.
            // Note that this will bypass any side effects caused by invoking the constructor.
            else {
                ret = Object.create(type_cache[json_obj._t].prototype);
                Object.assign(ret, derefed);
            }
        }
        
        // Finally, if this object is a reference that is used again, declare it within the deserialization table, and continue;
        if ("_r" in json_obj)
            deserialized_rs[json_obj._r] = ret;
        
        return ret;
    }
}
