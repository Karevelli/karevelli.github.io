// Rebuilds the node transforms of a model loaded by FBXLoader (three.js 0.186).
//
// FBXLoader resolves InheritType "Rrs" (the node ignores its parent's scaling, as joints with
// segment scale compensation do) with the scale of the parent's three.js local matrix instead of
// the parent's FBX Lcl Scaling. In chains of scaled joints the error compounds and whole parts of
// a skinned model collapse to a point. This applies the FBX SDK formula again, parents first, from
// the data the loader keeps in userData.transformData. Bones the loader moved to the BindPose get
// back their saved Lcl values too, so the model shows the pose it was saved in.

import { Euler, Matrix4, MathUtils, Vector3 } from 'three';

// Pre and post rotations always use the FBX default order, as in FBXLoader.
const DEFAULT_ORDER = 'ZYX';

function rotationMatrix(degrees, order)
{
    const euler = new Euler(MathUtils.degToRad(degrees[0]), MathUtils.degToRad(degrees[1]), MathUtils.degToRad(degrees[2]), order);
    return new Matrix4().makeRotationFromEuler(euler);
}

function translationMatrix(values)
{
    return values !== undefined ? new Matrix4().makeTranslation(values[0], values[1], values[2]) : new Matrix4();
}

function globalMatrix(data, parentGlobal, parentScaling)
{
    const translation = translationMatrix(data.translation);
    const rotation = data.rotation !== undefined ? rotationMatrix(data.rotation, data.eulerOrder || DEFAULT_ORDER) : new Matrix4();
    const preRotation = data.preRotation !== undefined ? rotationMatrix(data.preRotation, DEFAULT_ORDER) : new Matrix4();
    const postRotation = data.postRotation !== undefined ? rotationMatrix(data.postRotation, DEFAULT_ORDER).invert() : new Matrix4();
    const scaling = data.scale !== undefined ? new Matrix4().makeScale(data.scale[0], data.scale[1], data.scale[2]) : new Matrix4();
    const rotationOffset = translationMatrix(data.rotationOffset);
    const rotationPivot = translationMatrix(data.rotationPivot);
    const scalingOffset = translationMatrix(data.scalingOffset);
    const scalingPivot = translationMatrix(data.scalingPivot);

    const parentRotation = new Matrix4().extractRotation(parentGlobal);
    const parentTranslation = new Matrix4().copyPosition(parentGlobal);
    const parentRotationScaling = parentTranslation.invert().multiply(parentGlobal);
    const parentScalingGlobal = parentRotation.clone().invert().multiply(parentRotationScaling);
    const localRotation = preRotation.clone().multiply(rotation).multiply(postRotation);

    const globalRotationScaling = new Matrix4();
    const inheritType = data.inheritType || 0;
    if (inheritType === 0)
    {
        globalRotationScaling.copy(parentRotation).multiply(localRotation).multiply(parentScalingGlobal).multiply(scaling);
    }
    else if (inheritType === 1)
    {
        globalRotationScaling.copy(parentRotation).multiply(parentScalingGlobal).multiply(localRotation).multiply(scaling);
    }
    else
    {
        const parentLocalScalingInverse = new Matrix4().makeScale(1 / parentScaling.x, 1 / parentScaling.y, 1 / parentScaling.z);
        globalRotationScaling.copy(parentRotation).multiply(localRotation).multiply(parentScalingGlobal.multiply(parentLocalScalingInverse)).multiply(scaling);
    }

    const local = translation.multiply(rotationOffset).multiply(rotationPivot).multiply(preRotation).multiply(rotation).multiply(postRotation)
        .multiply(rotationPivot.clone().invert()).multiply(scalingOffset).multiply(scalingPivot).multiply(scaling).multiply(scalingPivot.clone().invert());
    const globalTranslation = parentGlobal.clone().multiply(new Matrix4().copyPosition(local));
    return new Matrix4().copyPosition(globalTranslation).multiply(globalRotationScaling);
}

export function rebuildFbxTransforms(root)
{
    root.updateMatrixWorld(true);
    const parentInverse = new Matrix4();
    root.traverse((node) =>
    {
        if (node === root)
        {
            return;
        }
        const data = node.userData.transformData;
        if (data !== undefined)
        {
            const parentData = node.parent.userData.transformData;
            const parentScaling = parentData !== undefined && parentData.scale !== undefined ? new Vector3().fromArray(parentData.scale) : new Vector3(1, 1, 1);
            const global = globalMatrix(data, node.parent.matrixWorld, parentScaling);
            parentInverse.copy(node.parent.matrixWorld).invert();
            parentInverse.multiply(global).decompose(node.position, node.quaternion, node.scale);
        }
        node.updateMatrix();
        node.matrixWorld.multiplyMatrices(node.parent.matrixWorld, node.matrix);
    });

    root.traverse((node) =>
    {
        if (node.isSkinnedMesh)
        {
            node.bind(node.skeleton, node.matrixWorld);
        }
    });
}
