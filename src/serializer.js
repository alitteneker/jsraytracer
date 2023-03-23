class Serializer {
    static SER_UID_GEN = 0;
    REF_UID_GEN = 0;
    constructor(data) {
        this.SER_ID = "_SID" + Serializer.SER_UID_GEN++;
        
        this.reforder = [];
        this.refs = {};
        this.data = this.serializeStep(data);
    }
    serializeStep(obj) {
        if (typeof obj == "function")
            throw "Cannot serialize functions to JSON";
        
        // Can't do anything more with primitive types: just return them without any further processing
        if (obj === null || obj === undefined || typeof obj != "object")
            return obj;
        
        // This must be an object. First check whether it has already been serialized, and if so return the reference.
        if (obj[this.SER_ID])
            return { _ref: obj[this.SER_ID] };
        
        // Register this object as a reference
        this.reforder.unshift(obj[this.SER_ID] = ++this.REF_UID_GEN);
        const ref = this.refs[obj[this.SER_ID]] = { _type: obj.constructor.name };
        
        // This object might have specified a serialize function.
        if (typeof obj.serialize == "function")
            obj.serialize(ref, this);
        
        // If this is an array, we can make a small performance savings with map over object enumeration.
        else if (obj instanceof Array)
            ref._val = obj.map(v => this.serializeStep(v));
        
        // This is a plain, vanilla object. Do each key val separately.
        else {
            ref._val = {};
            for (let [k,v] of Object.entries(obj))
                if (obj.hasOwnProperty(k) && k !== this.SER_ID)
                    ref._val[k] = this.serializeStep(v);
        }
        
        return { _ref: obj[this.SER_ID] };
    }
    toJSON() {
        return JSON.stringify({ refs: this.refs, reforder: this.reforder, data: this.data });
    }
    
    
    static deserializeJSON(json_data) {
        const deserialized_refs = {};
        for (let r of json_data.reforder)
            deserialized_refs[r] = Serializer.deserializeRef(json_data.refs[r], deserialized_refs);
        
        if (json_data.data === null || json_data.data === undefined || typeof json_data.data != "object")
            return json_data.data;
        if ("_ref" in json_data.data)
            return deserialized_refs[json_data.data._ref];
        
        throw "Something has gone wrong with deserialization";
    }
    static deserializeRef(json_obj, deserialized_refs) {
        if (json_obj === null || json_obj === undefined || typeof json_obj != "object")
            return json_obj;
        
        if ("_ref" in json_obj) {
            if (!(json_obj._ref in deserialized_refs))
                throw "Reference is out of order";
            return deserialized_refs[json_obj._ref];
        }
        
        if (json_obj._type == "Array")
            return json_obj._val.map(v => Serializer.deserializeRef(v, deserialized_refs));
        
        if (json_obj._type == "Object") {
            const ret = {};
            for (let [k,v] of Object.entries(json_obj._val))
                ret[k] = Serializer.deserializeRef(v, deserialized_refs);
            return ret;
        }
        
        if (!(json_obj._type in window))
            throw "Unknown type " + json_obj._type;
        const type = window[json_obj._type];
        if ("deserialize" in type)
            return type.deserialize(json_obj, deserialized_refs);
        
        throw "Unable to deserialize ref of type " + json_obj._type;
    }
}
