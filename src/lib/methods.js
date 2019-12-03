import firebase from 'firebase/app';
import 'firebase/firestore';
import 'firebase/storage';
import { CREATE } from 'react-admin';

const convertFileToBase64 = file =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file.rawFile);

    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
  });

const addUploadFeature = requestHandler => (type, resource, params) => {
  if (type === 'UPDATE') {
    if (params.data.image && params.data.image.length) {
      const formerPictures = params.data.image.filter(p => !(p.rawFile instanceof File));
      const newPictures = params.data.image.filter(p => p.rawFile instanceof File);

      return Promise.all(newPictures.map(convertFileToBase64))
        .then(base64Pictures =>
          base64Pictures.map(picture64 => ({
            src: picture64,
            title: `${params.data.title}`
          }))
        )
        .then(transformedNewPictures =>
          requestHandler(type, resource, {
            ...params,
            data: {
              ...params.data,
              image: [...transformedNewPictures, ...formerPictures]
            }
          })
        );
    }
  }
  // for other request types and reources, fall back to the defautl request handler
  return requestHandler(type, resource, params);
};

const getImageSize = file => {
  return new Promise(resolve => {
    const img = document.createElement('img');
    img.onload = function() {
      resolve({
        width: this.width,
        height: this.height
      });
    };
    img.src = file.src;
  });
};

const upload = async (fieldName, submitedData, id, resourceName, resourcePath) => {
  const file = submitedData[fieldName] && submitedData[fieldName][0];
  const rawFile = file.rawFile;

  const result = {};
  if (file && rawFile && rawFile.name) {
    const ref = firebase
      .storage()
      .ref()
      .child(`${resourcePath || resourceName}/${id}/${fieldName}`);
    const snapshot = await ref.put(rawFile);
    result[fieldName] = [{}];
    result[fieldName][0].uploadedAt = new Date();
    result[fieldName][0].src = snapshot.downloadURL.split('?').shift() + '?alt=media';
    result[fieldName][0].type = rawFile.type;
    if (rawFile.type.indexOf('image/') === 0) {
      try {
        const imageSize = await getImageSize(file);
        result[fieldName][0].width = imageSize.width;
        result[fieldName][0].height = imageSize.height;
      } catch (e) {
        console.error(`Failed to get image dimensions`);
      }
    }
    return result;
  }
  return false;
};

const save = async (
  id,
  data,
  previous,
  resourceName,
  resourcePath,
  firebaseSaveFilter,
  uploadResults,
  isNew,
  timestampFieldNames
) => {
  if (uploadResults) {
    uploadResults.map(uploadResult => (uploadResult ? Object.assign(data, uploadResult) : false));
  }

  if (isNew) {
    Object.assign(data, { [timestampFieldNames.createdAt]: new Date().getTime() });
  }

  data = Object.assign(previous, { [timestampFieldNames.updatedAt]: new Date().getTime() }, data);

  if (!data.id) {
    data.id = id;
  }

  await firebase
    .firestore()
    .doc(`${resourceName}/${data.id}`)
    .set(firebaseSaveFilter(data));
  return { data };
};

const del = async (id, resourceName, resourcePath, uploadFields) => {
  if (uploadFields.length) {
    uploadFields.map(fieldName =>
      firebase
        .storage()
        .ref()
        .child(`${resourcePath || resourceName}/${id}/${fieldName}`)
        .delete()
    );
  }

  await firebase
    .firestore()
    .doc(`${resourceName}/${id}`)
    .delete();
  return { data: id };
};

const delMany = async (ids, resourceName, previousData) => {
  await ids.map(id =>
    firebase
      .firestore()
      .doc(`${resourceName}/${id}`)
      .delete()
  );
  return { data: ids };
};

const getItemID = (params, type, resourceName, resourcePath, resourceData) => {
  let itemId = params.data.id || params.id || params.data.key || params.key;
  if (!itemId) {
    itemId = firebase
      .firestore()
      .collection(resourceName)
      .doc().id;
  }

  if (!itemId) {
    throw new Error('ID is required');
  }

  if (resourceData && resourceData[itemId] && type === CREATE) {
    throw new Error('ID already in use');
  }

  return itemId;
};

const getOne = async (params, resourceName, resourceData) => {
  if (params.id) {
    let result = await firebase
      .firestore()
      .collection(resourceName)
      .doc(params.id)
      .get();

    if (result.exists) {
      const data = result.data();

      if (data && data.id == null) {
        data['id'] = result.id;
      }
      return { data: data };
    } else {
      throw new Error('Id not found');
    }
  } else {
    throw new Error('Id not found');
  }
};

/**
 * params example:
 * pagination: { page: 1, perPage: 5 },
 * sort: { field: 'title', order: 'ASC' },
 * filter: { author_id: 12 }
 */
let firstPageIX = {};
let lastPageIX = {};
let paginationPage = {};


const getList = async (params, resourceName, tag) => {
  //  handles get list requests from dataProvider in uduX admin-portal
  if (params.pagination) {
    const perPage = 100;
    const { page } = params.pagination;
    let values = [];
    const field = 'created';
    const order = 'desc';
    const IXName = `${resourceName}${tag || ''}`;
    const first = firstPageIX[IXName];
    const last = lastPageIX[IXName];
    const lastPage = paginationPage[IXName] || 1;

    let fb = firebase.firestore().collection(resourceName);
     // checks if the property on the incoming parameter from dataProvider has value releasedate
     if(params.filter.sort == "releasedate") {
      const field = 'releasedate';
      fb = fb.where(field, '<=', params.filter.created._d);
      console.log("this is the query", fb);
    } else if (params.filter) {
      const fields = Object.keys(params.filter);
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        fb = fb.where(field, '==', params.filter[field]);
      }
  
    fb = fb.orderBy(field, order);
    if (page > lastPage && last) {
      fb = fb.startAfter(last);
    } else if (page < lastPage && first) {
      fb = fb.endBefore(first);
    } else if (last) {
      fb = fb.startAt(first);
    }
  }
    let snapshots = await fb.limit(perPage).get();
    let lastitem = {};
    for (const snapshot of snapshots.docs) {
      const data = snapshot.data();
      if (data && data.id == null) {
        data['id'] = snapshot.id;
      }
      values.push(data);
      lastitem = data;
    }
    paginationPage[IXName] = page;
    lastPageIX[IXName] = lastitem[field];
    firstPageIX[IXName] = values.length > 0 ? values[0][field] : null;

    console.log(IXName, 'page', page, 'lastPage', lastPage, 'last', last, 'first', first, values);
    // if (params.sort) {
    //   values.sort(sortBy(`${params.sort.order === 'ASC' ? '-' : ''}${params.sort.field}`));
    // }
    const _start = 0;
    const _end = values.length;
    const keys = values.map(i => i.id);
    const data = values ? values.slice(_start, _end) : [];
    const ids = keys.slice(_start, _end) || [];
    const total = 100000000000; // values ? values.length : 0;
    return { data, ids, total };
  } else {
    throw new Error('Error processing request');
  }
};

const getMany = async (params, resourceName, resourceData) => {
  let data = [];
  /* eslint-disable no-await-in-loop */
  for (const id of params.ids) {
    let { data: item } = await getOne({ id }, resourceName, resourceData);
    data.push(item);
  }
  return { data };
};

const getManyReference = async (params, resourceName, resourceData) => {
  if (params.target) {
    if (!params.filter) params.filter = {};
    params.filter[params.target] = params.id;
    let { data, total } = await getList(params, resourceName, resourceData, 'MANY_REFERENCE');
    return { data, total };
  } else {
    throw new Error('Error processing request');
  }
};

export default {
  upload,
  save,
  del,
  delMany,
  getItemID,
  getOne,
  getList,
  getMany,
  getManyReference,
  addUploadFeature,
  convertFileToBase64
};
